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
        Api.request(Communications.HTTP_REQUEST_METHOD_GET, "/api/device/pending", null, method(:onData));
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
        Background.exit(n);
    }
}
