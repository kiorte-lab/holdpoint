import Toybox.Application;
import Toybox.Communications;
import Toybox.Lang;

// Shared by the app, the glance and the background service.
(:background :glance)
module Api {
    function relay() as String {
        var u = Application.Properties.getValue("relayUrl");
        // Empty, or left over from the app's old name: use the current relay.
        if (u == null || !(u instanceof String) || (u as String).length() == 0 || (u as String).find("wristgate-relay") != null
                || (u as String).find("holdpoint-relay.kiorte.workers.dev") != null) {
            return "https://holdpoint.kiorte.com";
        }
        return u as String;
    }

    // A watch updated from Wristgate keeps its old relay setting and a token that only the old relay knows.
    // Point it at the new relay and start fresh, so it shows a new pairing code. Foreground only.
    function migrate() as Void {
        var u = Application.Properties.getValue("relayUrl");
        if (u instanceof String && (u as String).find("wristgate-relay") != null) {
            Application.Properties.setValue("relayUrl", "https://holdpoint.kiorte.com");
            Application.Properties.setValue("token", "");
            Application.Properties.setValue("lastCount", 0);
        } else if (u instanceof String && (u as String).find("holdpoint-relay.kiorte.workers.dev") != null) {
            // Same relay under its new name: the watch stays paired.
            Application.Properties.setValue("relayUrl", "https://holdpoint.kiorte.com");
        }
    }

    function token() as String? {
        var t = Application.Properties.getValue("token");
        if (t == null || !(t instanceof String) || (t as String).length() == 0) {
            return null;
        }
        return t as String;
    }

    function request(method, path as String, body, callback) as Void {
        var headers = { "Content-Type" => Communications.REQUEST_CONTENT_TYPE_JSON };
        var t = token();
        if (t != null) {
            headers["Authorization"] = "Bearer " + t;
        }
        var options = {
            :method => method,
            :headers => headers,
            :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
        };
        Communications.makeWebRequest(relay() + path, body, options, callback);
    }
}
