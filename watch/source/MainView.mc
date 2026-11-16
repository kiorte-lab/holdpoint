import Toybox.Application;
import Toybox.Attention;
import Toybox.Communications;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.System;
import Toybox.Timer;
import Toybox.WatchUi;


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
    var visible as Boolean = false;
    var version = null;                  // relay's change counter for this watch, for long-polling
    var longPoll as Boolean = true;      // off if the phone times the long-poll out
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
        visible = true;
        if (timer == null) {
            timer = new Timer.Timer();
        }
        poll();
    }

    function onHide() as Void {
        visible = false;
        if (timer != null) {
            (timer as Timer.Timer).stop();
        }
    }

    // Next check. The relay holds each request open until something changes (up to 20s),
    // so the watch asks about three times a minute rather than every few seconds.
    function later(ms as Number) as Void {
        if (!visible || timer == null) {
            return;
        }
        (timer as Timer.Timer).stop();
        (timer as Timer.Timer).start(method(:poll), ms, false);
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
        var path = "/api/device/pending";
        if (longPoll && version != null) {
            path = path + "?wait=20&v=" + version.toString();
        }
        Api.request(Communications.HTTP_REQUEST_METHOD_GET, path, null, method(:onPending));
        syncSettings();
    }

    // Settings changed in the Garmin Connect app: claim a pairing code, push reply buttons.
    function syncSettings() as Void {
        var pn = Application.Properties.getValue("pairNotice");
        if (pn instanceof String && pn.length() > 0) {
            notice = pn as String;
            Application.Properties.setValue("pairNotice", "");
        }
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
            later(500);
        } else {
            status = errorText(code);
            later(8000);
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
            if (code == Communications.NETWORK_REQUEST_TIMED_OUT && longPoll && version != null) {
                // The phone gave up on the held-open request: fall back to plain checks.
                longPoll = false;
                later(1000);
                return;
            }
            status = errorText(code);
            WatchUi.requestUpdate();
            later(8000);
            return;
        }
        status = "";
        version = data["version"];
        later(longPoll ? 300 : 5000);
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
        var xt = Graphics.getFontHeight(Graphics.FONT_XTINY);
        var round = System.getDeviceSettings().screenShape == System.SCREEN_SHAPE_ROUND;
        var shape = System.getDeviceSettings().screenShape;
        var bottom = round ? h * 0.90 : (shape == System.SCREEN_SHAPE_SEMI_OCTAGON ? h * 0.94 : h * 0.97);

        // Status: a pill at the top (tap it for Away / pairing), or inside the Instinct's little round subscreen.
        var top;
        var sub = subscreen();
        if (sub != null) {
            var cx = sub.x + sub.width / 2;
            var cy = sub.y + sub.height / 2;
            if (away) {
                dc.setColor(ORANGE, Graphics.COLOR_TRANSPARENT);
                dc.fillCircle(cx, cy, sub.width / 2);
            }
            dc.setColor(away ? Graphics.COLOR_BLACK : Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, cy, Graphics.FONT_XTINY, away ? "AWAY" : "DESK", Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
            top = sub.y + sub.height + 6;
        } else {
            var label = away ? "AWAY" : "AT DESK";
            var pw = dc.getTextWidthInPixels(label, Graphics.FONT_XTINY) + 36;
            var ph = xt + 8;
            var pc = round ? h * 0.13 : h * 0.09;
            dc.setColor(away ? ORANGE : 0x2A2F3A, Graphics.COLOR_TRANSPARENT);
            dc.fillRoundedRectangle(w / 2 - pw / 2, pc - ph / 2, pw, ph, ph / 2);
            centre(dc, label, Graphics.FONT_XTINY, away ? Graphics.COLOR_BLACK : Graphics.COLOR_WHITE, pc);
            top = pc + ph / 2 + 4;
        }

        if (status.length() > 0) {
            stack(dc, [[status, Graphics.FONT_SMALL, Graphics.COLOR_WHITE]], top, bottom);
            return;
        }

        if (showPair || (clients == 0 && pending.size() == 0)) {
            drawPair(dc, top, bottom);
            return;
        }

        var r = current();
        if (r == null) {
            var items = [
                ["All clear", Graphics.FONT_MEDIUM, Graphics.COLOR_WHITE],
                [away ? "Waiting for your agent" : (touch ? "Tap the pill to go Away" : "Hold UP for Away"), Graphics.FONT_XTINY, DIM]
            ];
            if (notice.length() > 0) { items.add([notice, Graphics.FONT_XTINY, GREEN]); }
            stack(dc, items, top, bottom);
            return;
        }

        var isStop = "stop".equals(r["kind"]);
        var agent = "Claude";
        if ("codex".equals(r["agent"])) { agent = "Codex"; }
        else if ("copilot".equals(r["agent"])) { agent = "Copilot"; }
        else if ("antigravity".equals(r["agent"])) { agent = "Antigravity"; }
        var locked = !isStop && r["locked"] == true;
        var head = isStop ? agent + " · finished" : (locked ? agent + " · locked" : agent + " · " + (r["tool"] as String));
        if (pending.size() > 1) {
            head = head + "  " + (index + 1).toString() + "/" + pending.size().toString();
        }
        var y = top + xt / 2;
        centre(dc, fit(dc, head, Graphics.FONT_XTINY, widthAt(dc, y)), Graphics.FONT_XTINY, isStop ? GREEN : (locked ? RED : ORANGE), y);

        // Bottom two lines: machine · folder, then what to press.
        var hintY = bottom - xt / 2;
        var whereY = hintY - xt;
        var areaTop = top + xt + 2;
        var areaH = whereY - xt / 2 - areaTop - 2;
        var areaW = widthAt(dc, areaTop + areaH / 2);
        var text = new WatchUi.TextArea({
            :text => r["summary"] as String,
            :color => Graphics.COLOR_WHITE,
            :font => [Graphics.FONT_SMALL, Graphics.FONT_TINY, Graphics.FONT_XTINY],
            :locX => (w - areaW) / 2,
            :locY => areaTop,
            :width => areaW,
            :height => areaH,
            :justification => Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER
        });
        text.draw(dc);

        var where = r["clientName"] as String;
        var cwd = r["cwd"];
        if (cwd instanceof String && cwd.length() > 0) {
            where = where + " · " + baseName(cwd as String);
        }
        centre(dc, fit(dc, where, Graphics.FONT_XTINY, widthAt(dc, whereY)), Graphics.FONT_XTINY, DIM, whereY);

        var verb = touch ? "Tap" : "START";
        var hint = isStop ? verb + " to read" : (r["locked"] == true ? verb + " to deny" : verb + " to answer");
        centre(dc, fit(dc, hint, Graphics.FONT_XTINY, widthAt(dc, hintY)), Graphics.FONT_XTINY, isStop ? GREEN : (locked ? RED : ORANGE), hintY);
    }

    // The Instinct's round window in the top-right corner, if this watch has one.
    function subscreen() {
        if (WatchUi has :getSubscreen) {
            return WatchUi.getSubscreen();
        }
        return null;
    }

    // Last folder of a path ("/home/me/shop-api" or "C:\\code\\shop-api" -> "shop-api").
    function baseName(path as String) as String {
        var chars = path.toCharArray();
        var end = chars.size();
        while (end > 0 && (chars[end - 1] == '/' || chars[end - 1] == '\\')) { end--; }
        var start = end;
        while (start > 0 && chars[start - 1] != '/' && chars[start - 1] != '\\') { start--; }
        return start < end ? path.substring(start, end) as String : path;
    }

    // Shorten text with an ellipsis until it fits maxW pixels.
    function fit(dc as Graphics.Dc, s as String, font, maxW) as String {
        if (dc.getTextWidthInPixels(s, font) <= maxW) { return s; }
        var n = s.length();
        while (n > 1 && dc.getTextWidthInPixels(s.substring(0, n) + "…", font) > maxW) { n--; }
        return s.substring(0, n) + "…";
    }

    function drawPair(dc as Graphics.Dc, top, bottom) as Void {
        var code = pairCode == null ? "......" : pairCode as String;
        var items = [
            ["On your PC run", Graphics.FONT_XTINY, DIM, true],
            ["holdpoint pair", Graphics.FONT_SMALL, Graphics.COLOR_WHITE],
            [code, codeFont(dc, code), ORANGE],
            ["or enter the PC's code", Graphics.FONT_XTINY, DIM],
            ["in Garmin Connect", Graphics.FONT_XTINY, DIM]
        ];
        if (notice.length() > 0) {
            items.add([notice, Graphics.FONT_XTINY, GREEN]);
        } else if (showPair) {
            items.add([touch ? "Tap when done" : "START when done", Graphics.FONT_XTINY, ORANGE]);
        }
        stack(dc, items, top, bottom);
    }

    // Draws lines centred as a block between top and bottom, spaced by real font heights,
    // each trimmed to the width the screen has at that height (round screens are narrower near the edges).
    function stack(dc as Graphics.Dc, items as Array, top, bottom) as Void {
        var total = 0;
        for (var i = 0; i < items.size(); i++) { total += lineH((items[i] as Array)[1]); }
        // Too tall for a small screen: drop lines marked optional (4th element true).
        for (var i = items.size() - 1; i >= 0 && total > bottom - top; i--) {
            var it = items[i] as Array;
            if (it.size() > 3 && it[3] == true) {
                total -= lineH(it[1]);
                items = items.slice(0, i).addAll(items.slice(i + 1, null));
            }
        }
        var y = top + ((bottom - top) - total) / 2;
        if (y < top) { y = top; }
        for (var i = 0; i < items.size(); i++) {
            var it = items[i] as Array;
            var lh = lineH(it[1]);
            var mid = y + lh / 2;
            centre(dc, fit(dc, it[0] as String, it[1], widthAt(dc, mid)), it[1], it[2], mid);
            y += lh;
        }
    }

    // The biggest font that shows all six digits of the pairing code across the middle of the screen.
    function codeFont(dc as Graphics.Dc, code as String) {
        var maxW = widthAt(dc, dc.getHeight() / 2);
        var fonts = [Graphics.FONT_NUMBER_MEDIUM, Graphics.FONT_NUMBER_MILD, Graphics.FONT_LARGE, Graphics.FONT_MEDIUM];
        for (var i = 0; i < fonts.size(); i++) {
            if (dc.getTextWidthInPixels(code, fonts[i]) <= maxW) { return fonts[i]; }
        }
        return Graphics.FONT_SMALL;
    }

    // Number fonts carry a lot of empty space above and below the digits.
    function lineH(font) as Number {
        var fh = Graphics.getFontHeight(font);
        if (font == Graphics.FONT_NUMBER_MEDIUM || font == Graphics.FONT_NUMBER_HOT || font == Graphics.FONT_NUMBER_MILD) {
            return fh;
        }
        return fh;
    }

    // Usable text width at a given y: the chord of a round screen, or the full width (less a margin) otherwise.
    function widthAt(dc as Graphics.Dc, y) as Number {
        var w = dc.getWidth();
        var ds = System.getDeviceSettings();
        if (ds.screenShape == System.SCREEN_SHAPE_ROUND) {
            var r = w / 2.0;
            var d = (y - dc.getHeight() / 2.0).abs();
            if (d >= r) { return 0; }
            return (2 * Math.sqrt(r * r - d * d) * 0.88).toNumber();
        }
        if (ds.screenShape == System.SCREEN_SHAPE_SEMI_OCTAGON) {
            // Instinct: the bottom corners are cut off at 45 degrees.
            var f = y / dc.getHeight().toFloat();
            var k = f > 0.78 ? 0.95 - (f - 0.78) * 1.8 : 0.95;
            return (w * k).toNumber();
        }
        return (w * 0.9).toNumber();
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
