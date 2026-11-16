import Toybox.Application;
import Toybox.Background;
import Toybox.Communications;
import Toybox.Lang;
import Toybox.System;

// Runs every 5 minutes with the app closed: counts what's waiting, and if something new
// arrived while you're away, asks the watch to offer opening Holdpoint.
(:background)
class HoldpointService extends System.ServiceDelegate {
    function initialize() {
        ServiceDelegate.initialize();
    }

    function onTemporalEvent() as Void {
        if (Api.token() == null) {
            Background.exit(null);
            return;
        }
        // A pairing code typed into Garmin Connect while the app was closed: claim it now,
        // so pairing finishes without having to open the app.
        var code = Application.Properties.getValue("pairingCode");
        if (code instanceof String && (code as String).length() >= 6) {
            Api.request(Communications.HTTP_REQUEST_METHOD_POST, "/api/device/claim", { "code" => digits(code as String) }, method(:onClaimed));
            return;
        }
        checkPending();
    }

    function checkPending() as Void {
        Api.request(Communications.HTTP_REQUEST_METHOD_GET, "/api/device/pending", null, method(:onData));
    }

    var claimed as String = "";
    var used as Boolean = false;

    function onClaimed(code, data) as Void {
        // 200 paired, 404 expired: either way the code is used up. The app clears it.
        // (A 404 can also be a code this service already claimed on an earlier run, so stay quiet then.)
        if (code == 200 || code == 404) {
            used = true;
            if (code == 200 && data instanceof Dictionary) { claimed = "Paired " + data["name"]; }
        }
        checkPending();
    }

    function digits(s as String) as String {
        var out = "";
        var cs = s.toCharArray();
        for (var i = 0; i < cs.size(); i++) {
            if (cs[i] >= '0' && cs[i] <= '9') { out += cs[i].toString(); }
        }
        return out;
    }

    function onData(code, data) as Void {
        var n = 0;
        if (code == 200 && data instanceof Dictionary) {
            var list = data["pending"];
            if (list instanceof Array) {
                n = list.size();
            }
            var prev = Application.Properties.getValue("lastCount");
            if (data["away"] == true && n > 0 && (!(prev instanceof Number) || n > prev)) {
                if (Background has :requestApplicationWake) {
                    Background.requestApplicationWake("Your agent needs you");
                }
            }
        }
        Background.exit(used ? { "count" => n, "claimed" => claimed } : n);
    }
}
