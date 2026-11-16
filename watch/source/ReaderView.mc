import Toybox.Graphics;
import Toybox.Lang;
import Toybox.StringUtil;
import Toybox.System;
import Toybox.Timer;
import Toybox.WatchUi;

// Full text of a card (Claude's whole last message, or the full command).
// Drag to scroll freely (flick for momentum), buttons step a few lines, tap to answer.
class ReaderView extends WatchUi.View {
    var req as Dictionary;
    var text as String;
    var lines as Array or Null = null;
    var offset as Float = 0.0;     // pixels scrolled
    var maxOffset as Float = 0.0;
    var velocity as Float = 0.0;   // px per frame, for flick momentum
    var lineH as Number = 30;
    var timer as Timer.Timer or Null = null;
    const FONT = Graphics.FONT_TINY;

    function initialize(r as Dictionary) {
        View.initialize();
        req = r;
        var d = r["detail"];
        var s = r["summary"];
        text = (d instanceof String && d.length() > 0) ? d : ((s instanceof String) ? s : "");
    }

    // Word-wrap to the screen width. Newlines are kept as paragraph breaks.
    function wrap(dc as Graphics.Dc, maxW as Number) as Array {
        var out = [];
        var chars = text.toCharArray();
        var word = [];
        var line = "";
        for (var i = 0; i <= chars.size(); i++) {
            var c = i < chars.size() ? chars[i] : '\n';
            if (c == ' ' || c == '\n' || c == '\t' || c == '\r') {
                if (word.size() > 0) {
                    var w = StringUtil.charArrayToString(word);
                    // A single word wider than the screen (paths, URLs): break it by character.
                    while (dc.getTextWidthInPixels(w, FONT) > maxW && w.length() > 1) {
                        if (line.length() > 0) {
                            out.add(line);
                            line = "";
                        }
                        var n = w.length() - 1;
                        while (n > 1 && dc.getTextWidthInPixels(w.substring(0, n), FONT) > maxW) {
                            n--;
                        }
                        out.add(w.substring(0, n));
                        w = w.substring(n, w.length());
                    }
                    var t = line.length() == 0 ? w : line + " " + w;
                    if (line.length() > 0 && dc.getTextWidthInPixels(t, FONT) > maxW) {
                        out.add(line);
                        line = w;
                    } else {
                        line = t;
                    }
                    word = [];
                }
                if (c == '\n') {
                    if (line.length() > 0) {
                        out.add(line);
                        line = "";
                    } else if (out.size() > 0 && !"".equals(out[out.size() - 1])) {
                        out.add(""); // blank line between paragraphs
                    }
                }
            } else {
                word.add(c);
            }
        }
        if (line.length() > 0) {
            out.add(line);
        }
        return out;
    }

    function clamp() as Void {
        if (offset < 0.0) {
            offset = 0.0;
            velocity = 0.0;
        }
        if (offset > maxOffset) {
            offset = maxOffset;
            velocity = 0.0;
        }
    }

    // Finger moved by dy pixels (positive = finger moved up = text scrolls up).
    function dragBy(dy as Float) as Void {
        stopFling();
        offset += dy;
        clamp();
        WatchUi.requestUpdate();
    }

    // Button or swipe without drag support: move about three lines.
    function step(dir as Number) as Void {
        stopFling();
        offset += dir * lineH * 3.0;
        clamp();
        WatchUi.requestUpdate();
    }

    function fling(v as Float) as Void {
        velocity = v;
        if (velocity > -1.0 && velocity < 1.0) {
            return;
        }
        if (timer == null) {
            timer = new Timer.Timer();
        }
        (timer as Timer.Timer).start(method(:onFrame), 40, true);
    }

    function onFrame() as Void {
        offset += velocity;
        velocity *= 0.88;
        clamp();
        if (velocity > -0.8 && velocity < 0.8) {
            stopFling();
        }
        WatchUi.requestUpdate();
    }

    function stopFling() as Void {
        velocity = 0.0;
        if (timer != null) {
            (timer as Timer.Timer).stop();
        }
    }

    function onHide() as Void {
        stopFling();
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
        dc.clear();
        if (lines == null) {
            lines = wrap(dc, (w * 0.72).toNumber());
        }
        var all = lines as Array;
        var isStop = "stop".equals(req["kind"]);
        var accent = isStop ? GREEN : ORANGE;

        var lh = Graphics.getFontHeight(FONT);
        lineH = lh;
        var y0 = (h * 0.19).toNumber();
        var y1 = (h * 0.80).toNumber();
        var viewH = y1 - y0;
        maxOffset = (all.size() * lh - viewH).toFloat();
        if (maxOffset < 0.0) {
            maxOffset = 0.0;
        }
        clamp();
        // Only draw the lines inside the window, clipped so text slides under the edges.
        dc.setClip(0, y0, w, viewH);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        var first = (offset / lh).toNumber();
        for (var i = first; i < all.size(); i++) {
            var y = y0 + i * lh - offset;
            if (y > y1) {
                break;
            }
            dc.drawText(w / 2, y, FONT, all[i] as String, Graphics.TEXT_JUSTIFY_CENTER);
        }
        dc.clearClip();

        // Scroll position: a thin bar on the right edge.
        if (maxOffset > 0.0) {
            var trackH = h * 0.5;
            var trackY = h * 0.25;
            var barH = trackH * viewH / (all.size() * lh);
            var barY = trackY + (trackH - barH) * offset / maxOffset;
            dc.setColor(0x2A2F3A, Graphics.COLOR_TRANSPARENT);
            dc.fillRoundedRectangle(w - 18, trackY, 6, trackH, 3);
            dc.setColor(accent, Graphics.COLOR_TRANSPARENT);
            dc.fillRoundedRectangle(w - 18, barY, 6, barH, 3);
        }

        var ds = System.getDeviceSettings();
        var verb = ((ds has :isTouchScreen) && ds.isTouchScreen) ? "Tap" : "START";
        var hint = isStop ? verb + " to reply" : (req["locked"] == true ? verb + " to deny" : verb + " to answer");
        dc.setColor(accent, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h * 0.86, Graphics.FONT_XTINY, hint, Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }
}

class ReaderDelegate extends WatchUi.BehaviorDelegate {
    var main as MainView;
    var reader as ReaderView;
    var req as Dictionary;
    var lastY as Number = 0;
    var lastT as Number = 0;
    var speed as Float = 0.0;
    var moved as Number = 0;          // total drag distance, to tell a tap from a scroll
    var dragEndedAt as Number = -10000;

    function initialize(m as MainView, v as ReaderView, r as Dictionary) {
        BehaviorDelegate.initialize();
        main = m;
        reader = v;
        req = r;
    }

    function onDrag(evt as WatchUi.DragEvent) as Boolean {
        var y = evt.getCoordinates()[1];
        var t = System.getTimer();
        var type = evt.getType();
        if (type == WatchUi.DRAG_TYPE_START) {
            reader.stopFling();
            lastY = y;
            lastT = t;
            speed = 0.0;
            moved = 0;
        } else if (type == WatchUi.DRAG_TYPE_CONTINUE) {
            var dy = lastY - y;
            moved += dy < 0 ? -dy : dy;
            var dt = t - lastT;
            if (dt > 0) {
                // smoothed px-per-40ms-frame, for the flick at the end
                speed = speed * 0.5 + (dy.toFloat() * 40.0 / dt) * 0.5;
            }
            reader.dragBy(dy.toFloat());
            lastY = y;
            lastT = t;
        } else if (type == WatchUi.DRAG_TYPE_STOP) {
            dragEndedAt = t;
            if (moved > 8) {
                reader.fling(speed);
            }
        }
        return true;
    }

    // Swipes arrive after a drag too; ignore those so one gesture doesn't scroll twice.
    function recentlyDragged() as Boolean {
        return System.getTimer() - dragEndedAt < 400 && moved > 8;
    }

    function onNextPage() as Boolean {
        if (!recentlyDragged()) {
            reader.step(1);
        }
        return true;
    }

    function onPreviousPage() as Boolean {
        if (!recentlyDragged()) {
            reader.step(-1);
        }
        return true;
    }

    function onSelect() as Boolean {
        main.openActions(req);
        return true;
    }

    function onTap(evt as WatchUi.ClickEvent) as Boolean {
        if (!recentlyDragged()) {
            main.openActions(req);
        }
        return true;
    }
}
