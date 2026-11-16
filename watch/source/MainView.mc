import Toybox.Application;
import Toybox.Attention;
import Toybox.Communications;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.System;
import Toybox.Timer;
import Toybox.WatchUi;

const ORANGE = 0xD97757;
const GREEN = 0x2FBF71;
const RED = 0xE5484D;
const DIM = 0x8B92A3;

// One card at a time: swipe up/down to move between them, tap to answer,
// hold the bottom button (menu) for Away / pairing.
class MainView extends WatchUi.View {
    var pending as Array = [];
    var presets as Array = ["Continue", "Run the tests", "Commit and push", "Summarise what you did"];
    var away as Boolean = false;
    var clients as Number = -1;
    var index as Number = 0;
    var status as String = "Connecting...";
    var pairCode as String or Null = null;
    var showPair as Boolean = false;
    var seen as Dictionary = {};
    var loaded as Boolean = false;
    var busy as Boolean = false;
    var timer as Timer.Timer or Null = null;
    var notice as String = "";          // one-off message, e.g. "Paired desk-pc"
    var claiming as Boolean = false;
    var touch as Boolean = false;        // touchscreen (Venu, Vivoactive) vs buttons only (Fenix, Forerunner)

    function initialize() {
        View.initialize();
        var a = Application.Properties.getValue("away");
        away = a == true;
        var ds = System.getDeviceSettings();
        touch = (ds has :isTouchScreen) && ds.isTouchScreen;
    }

    function onShow() as Void {
        if (timer == null) {
            timer = new Timer.Timer();
        }
        (timer as Timer.Timer).start(method(:poll), 4000, true);
        poll();
    }

    function onHide() as Void {
        if (timer != null) {
            (timer as Timer.Timer).stop();
        }
    }

    // ---------- networking ----------
    function poll() as Void {
        if (busy) {
            return;
        }
        busy = true;
        if (Api.token() == null) {
            status = "Setting up...";
            Api.request(Communications.HTTP_REQUEST_METHOD_POST, "/api/devices", { "name" => "Watch" }, method(:onRegistered));
            return;
        }
        Api.request(Communications.HTTP_REQUEST_METHOD_GET, "/api/device/pending", null, method(:onPending));
        syncSettings();
    }

    // Settings changed in the Garmin Connect app: claim a pairing code, push reply buttons.
    function syncSettings() as Void {
        var code = Application.Properties.getValue("pairingCode");
        if (!claiming && code instanceof String && code.length() > 0) {
            var digits = digitsOnly(code as String);
            if (digits.length() == 6) {
                claiming = true;
                Api.request(Communications.HTTP_REQUEST_METHOD_POST, "/api/device/claim", { "code" => digits }, method(:onClaimed));
            } else {
                Application.Properties.setValue("pairingCode", "");
                notice = "Pairing code needs 6 digits";
            }
        }
        var text = Application.Properties.getValue("presetsText");
        var sent = Application.Properties.getValue("presetsSent");
        if (text instanceof String && !(text as String).equals(sent)) {
            var list = splitPresets(text as String);
            if (list.size() > 0) {
                Application.Properties.setValue("presetsSent", text);
                Api.request(Communications.HTTP_REQUEST_METHOD_POST, "/api/device/settings", { "presets" => list }, method(:onDecided));
            }
        }
    }

    function onClaimed(code, data) as Void {
        claiming = false;
        Application.Properties.setValue("pairingCode", "");
        if (code == 200 && data instanceof Dictionary) {
            notice = "Paired " + data["name"];
            showPair = false;
            buzz();
        } else if (code == 404) {
            notice = "Code expired - run holdpoint pair again";
        } else {
            notice = errorText(code);
        }
        WatchUi.requestUpdate();
    }

    function digitsOnly(s as String) as String {
        var out = "";
        var cs = s.toCharArray();
        for (var i = 0; i < cs.size(); i++) {
            if (cs[i] >= '0' && cs[i] <= '9') {
                out = out + cs[i].toString();
            }
        }
        return out;
    }

    function splitPresets(s as String) as Array {
        var out = [];
        var rest = s;
        while (rest.length() > 0 && out.size() < 8) {
            var i = rest.find(",");
            var part = i == null ? rest : rest.substring(0, i);
            rest = i == null ? "" : rest.substring(i + 1, rest.length());
            // trim spaces
            var cs = part.toCharArray();
            var a = 0;
            var b = cs.size();
            while (a < b && cs[a] == ' ') { a++; }
            while (b > a && cs[b - 1] == ' ') { b--; }
            if (b > a) {
                out.add(part.substring(a, b));
            }
        }
        return out;
    }

    function onRegistered(code, data) as Void {
        busy = false;
        if (code == 201 && data instanceof Dictionary) {
            Application.Properties.setValue("token", data["deviceToken"]);
            pairCode = data["pairCode"];
            clients = 0;
            status = "";
        } else {
            status = errorText(code);
        }
        WatchUi.requestUpdate();
    }

    function onPending(code, data) as Void {
        busy = false;
        if (code == 401) {
            // Token no longer valid (e.g. relay reset): register again.
            Application.Properties.setValue("token", "");
            pairCode = null;
            poll();
            return;
        }
        if (code != 200 || !(data instanceof Dictionary)) {
            status = errorText(code);
            WatchUi.requestUpdate();
            return;
        }
        status = "";
        var list = data["pending"];
        if (!(list instanceof Array)) {
            list = [];
        }
        var now = {};
        var fresh = false;
        for (var i = 0; i < list.size(); i++) {
            var id = (list[i] as Dictionary)["id"];
            if (!seen.hasKey(id)) {
                fresh = true;
            }
            now[id] = true;
        }
        if (fresh && loaded) {
            buzz();
        }
        seen = now;
        loaded = true;
        pending = list;
        if (index >= pending.size()) {
            index = 0;
        }
        away = data["away"] == true;
        Application.Properties.setValue("away", away);
        if (data["presets"] instanceof Array) {
            presets = data["presets"];
        }
        var c = data["clients"];
        if (c instanceof Number) {
            clients = c;
            if (c == 0 && pairCode == null) {
                requestPairCode();
            }
        }
        Application.Properties.setValue("lastCount", pending.size());
        WatchUi.requestUpdate();
    }

    function requestPairCode() as Void {
        Api.request(Communications.HTTP_REQUEST_METHOD_POST, "/api/device/pair-code", {}, method(:onPairCode));
    }

    function onPairCode(code, data) as Void {
        if (code == 200 && data instanceof Dictionary) {
            pairCode = data["pairCode"];
        }
        WatchUi.requestUpdate();
    }

    function decide(id as String, body as Dictionary) as Void {
        // Optimistic: drop the card now, the next poll confirms.
        var keep = [];
        for (var i = 0; i < pending.size(); i++) {
            if (!((pending[i] as Dictionary)["id"]).equals(id)) {
                keep.add(pending[i]);
            }
        }
        pending = keep;
        if (index >= pending.size()) {
            index = 0;
        }
        WatchUi.requestUpdate();
        Api.request(Communications.HTTP_REQUEST_METHOD_POST, "/api/device/requests/" + id + "/decision", body, method(:onDecided));
    }

    function onDecided(code, data) as Void {
        if (code != 200) {
            status = "Not sent (" + code.toString() + ")";
        }
        poll();
    }

    function setAway(on as Boolean) as Void {
        away = on;
        Application.Properties.setValue("away", on);
        WatchUi.requestUpdate();
        Api.request(Communications.HTTP_REQUEST_METHOD_POST, "/api/device/settings", { "away" => on }, method(:onDecided));
    }

    function errorText(code) as String {
        if (code instanceof Number && code < 0) {
            return "Phone not connected";
        }
        return "Relay error " + code.toString();
    }

    function buzz() as Void {
        if (Attention has :vibrate) {
            Attention.vibrate([new Attention.VibeProfile(60, 250), new Attention.VibeProfile(0, 150), new Attention.VibeProfile(60, 250)]);
        }
    }

    // ---------- input ----------
    function move(step as Number) as Void {
        if (pending.size() > 1) {
            index = (index + step + pending.size()) % pending.size();
            WatchUi.requestUpdate();
        }
    }

    function current() as Dictionary or Null {
        if (pending.size() == 0) {
            return null;
        }
        return pending[index] as Dictionary;
    }

    function openCurrent() as Void {
        notice = "";
        if (showPair) {
            showPair = false;
            WatchUi.requestUpdate();
            return;
        }
        var r = current();
        if (r == null) {
            openSettings();
            return;
        }
        // Read the whole thing first, then tap again to answer.
        var reader = new ReaderView(r);
        WatchUi.pushView(reader, new ReaderDelegate(self, reader, r), WatchUi.SLIDE_LEFT);
    }

    function openActions(r as Dictionary) as Void {
        var isStop = "stop".equals(r["kind"]);
        var menu = new WatchUi.Menu2({ :title => isStop ? "Reply" : "Answer" });
        if (isStop) {
            for (var i = 0; i < presets.size(); i++) {
                menu.addItem(new WatchUi.MenuItem(presets[i] as String, null, i, null));
            }
            menu.addItem(new WatchUi.MenuItem("Done for now", "Let it stop", :dismiss, null));
        } else {
            if (r["locked"] != true) {
                menu.addItem(new WatchUi.MenuItem("Approve", null, :approve, null));
            }
            menu.addItem(new WatchUi.MenuItem("Deny", r["locked"] == true ? "Too risky to approve here" : null, :deny, null));
        }
        WatchUi.pushView(menu, new ActionDelegate(self, r["id"] as String), WatchUi.SLIDE_LEFT);
    }

    function openSettings() as Void {
        var menu = new WatchUi.Menu2({ :title => "Holdpoint" });
        menu.addItem(new WatchUi.ToggleMenuItem("Away", { :enabled => "Prompts come here", :disabled => "Prompts stay on the PC" }, :away, away, null));
        menu.addItem(new WatchUi.MenuItem("Pair or link", "Show a 6-digit code", :pair, null));
        WatchUi.pushView(menu, new SettingsDelegate(self), WatchUi.SLIDE_UP);
    }

    function startPairing() as Void {
        showPair = true;
        pairCode = null;
        requestPairCode();
    }

    // ---------- drawing ----------
    function onUpdate(dc as Graphics.Dc) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
        dc.clear();

        // Status pill at the top: tap it for Away / pairing.
        var label = away ? "AWAY" : "AT DESK";
        var pw = dc.getTextWidthInPixels(label, Graphics.FONT_XTINY) + 36;
        var ph = Graphics.getFontHeight(Graphics.FONT_XTINY) + 8;
        var py = h * 0.13 - ph / 2;
        dc.setColor(away ? ORANGE : 0x2A2F3A, Graphics.COLOR_TRANSPARENT);
        dc.fillRoundedRectangle(w / 2 - pw / 2, py, pw, ph, ph / 2);
        centre(dc, label, Graphics.FONT_XTINY, away ? Graphics.COLOR_BLACK : Graphics.COLOR_WHITE, h * 0.13);

        if (status.length() > 0) {
            centre(dc, status, Graphics.FONT_SMALL, Graphics.COLOR_WHITE, h * 0.45);
            return;
        }

        if (showPair || (clients == 0 && pending.size() == 0)) {
            drawPair(dc, w, h);
            return;
        }

        var r = current();
        if (r == null) {
            centre(dc, "All clear", Graphics.FONT_MEDIUM, Graphics.COLOR_WHITE, h * 0.40);
            centre(dc, away ? "Waiting for your agent" : (touch ? "Tap the pill to go Away" : "Hold UP for Away"), Graphics.FONT_XTINY, DIM, h * 0.58);
            if (notice.length() > 0) {
                centre(dc, notice.length() > 24 ? notice.substring(0, 23) + "..." : notice, Graphics.FONT_XTINY, GREEN, h * 0.72);
            }
            return;
        }

        var isStop = "stop".equals(r["kind"]);
        var agent = "Claude";
        if ("codex".equals(r["agent"])) { agent = "Codex"; }
        else if ("copilot".equals(r["agent"])) { agent = "Copilot"; }
        else if ("antigravity".equals(r["agent"])) { agent = "Antigravity"; }
        var head = isStop ? agent + " · finished" : agent + " · " + (r["tool"] as String);
        dc.setColor(isStop ? GREEN : ORANGE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h * 0.21, Graphics.FONT_XTINY, head, Graphics.TEXT_JUSTIFY_CENTER);

        var text = new WatchUi.TextArea({
            :text => r["summary"] as String,
            :color => Graphics.COLOR_WHITE,
            :font => [Graphics.FONT_SMALL, Graphics.FONT_TINY, Graphics.FONT_XTINY],
            :locX => w * 0.12,
            :locY => h * 0.30,
            :width => w * 0.76,
            :height => h * 0.38,
            :justification => Graphics.TEXT_JUSTIFY_CENTER
        });
        text.draw(dc);

        var where = r["clientName"] as String;
        var cwd = r["cwd"];
        if (cwd instanceof String && cwd.length() > 0) {
            where = where + " · " + cwd;
        }
        centre(dc, where, Graphics.FONT_XTINY, DIM, h * 0.70);

        var verb = touch ? "Tap" : "START";
        var hint = isStop ? verb + " to read & reply" : (r["locked"] == true ? verb + " to deny" : verb + " to answer");
        if (pending.size() > 1) {
            hint = hint + "   " + (index + 1).toString() + "/" + pending.size().toString();
        }
        centre(dc, hint, Graphics.FONT_XTINY, isStop ? GREEN : ORANGE, h * 0.82);
    }

    function drawPair(dc as Graphics.Dc, w, h) as Void {
        centre(dc, "On your PC run", Graphics.FONT_XTINY, DIM, h * 0.27);
        centre(dc, "holdpoint pair", Graphics.FONT_SMALL, Graphics.COLOR_WHITE, h * 0.35);
        centre(dc, pairCode == null ? "......" : pairCode as String, Graphics.FONT_NUMBER_MEDIUM, ORANGE, h * 0.50);
        centre(dc, "or enter the PC's code in", Graphics.FONT_XTINY, DIM, h * 0.67);
        centre(dc, "Garmin Connect > Holdpoint", Graphics.FONT_XTINY, DIM, h * 0.74);
        if (showPair) {
            centre(dc, touch ? "Tap when done" : "START when done", Graphics.FONT_XTINY, ORANGE, h * 0.84);
        }
    }

    function centre(dc as Graphics.Dc, text as String, font, colour, y) as Void {
        dc.setColor(colour, Graphics.COLOR_TRANSPARENT);
        dc.drawText(dc.getWidth() / 2, y, font, text, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }
}

class MainDelegate extends WatchUi.BehaviorDelegate {
    var view as MainView;

    function initialize(v as MainView) {
        BehaviorDelegate.initialize();
        view = v;
    }

    function onSelect() as Boolean {
        view.openCurrent();
        return true;
    }

    // Touch: the status pill at the top opens settings, anywhere else answers the card.
    function onTap(evt as WatchUi.ClickEvent) as Boolean {
        var xy = evt.getCoordinates();
        if (xy[1] < System.getDeviceSettings().screenHeight * 0.20) {
            view.openSettings();
        } else {
            view.openCurrent();
        }
        return true;
    }

    function onNextPage() as Boolean {
        view.move(1);
        return true;
    }

    function onPreviousPage() as Boolean {
        view.move(-1);
        return true;
    }

    function onMenu() as Boolean {
        view.openSettings();
        return true;
    }
}

class ActionDelegate extends WatchUi.Menu2InputDelegate {
    var view as MainView;
    var reqId as String;

    function initialize(v as MainView, id as String) {
        Menu2InputDelegate.initialize();
        view = v;
        reqId = id;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        var id = item.getId();
        var body;
        if (id == :approve) {
            body = { "decision" => "allow" };
        } else if (id == :deny) {
            body = { "decision" => "deny" };
        } else if (id == :dismiss) {
            body = { "decision" => "dismiss" };
        } else {
            body = { "decision" => "reply", "reply" => view.presets[id as Number] };
        }
        WatchUi.popView(WatchUi.SLIDE_IMMEDIATE); // the menu
        WatchUi.popView(WatchUi.SLIDE_RIGHT);     // the reader underneath it
        view.decide(reqId, body);
    }
}

class SettingsDelegate extends WatchUi.Menu2InputDelegate {
    var view as MainView;

    function initialize(v as MainView) {
        Menu2InputDelegate.initialize();
        view = v;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        var id = item.getId();
        if (id == :away) {
            view.setAway((item as WatchUi.ToggleMenuItem).isEnabled());
        } else if (id == :pair) {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            view.startPairing();
        }
    }
}
