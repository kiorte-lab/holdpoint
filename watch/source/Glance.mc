import Toybox.Application;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.WatchUi;

(:glance)
class WristgateGlance extends WatchUi.GlanceView {
    function initialize() {
        GlanceView.initialize();
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        var n = Application.Properties.getValue("lastCount");
        var h = dc.getHeight();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(0, h * 0.3, Graphics.FONT_GLANCE, "WRISTGATE",
            Graphics.TEXT_JUSTIFY_LEFT | Graphics.TEXT_JUSTIFY_VCENTER);
        var label = "All clear";
        var colour = 0x8B92A3;
        if (n instanceof Number && n > 0) {
            label = n.toString() + " waiting for you";
            colour = 0xD97757;
        }
        dc.setColor(colour, Graphics.COLOR_TRANSPARENT);
        dc.drawText(0, h * 0.72, Graphics.FONT_GLANCE, label,
            Graphics.TEXT_JUSTIFY_LEFT | Graphics.TEXT_JUSTIFY_VCENTER);
    }
}
