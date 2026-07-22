// Field background: USA Lacrosse Women's Field Diagram image
// The image has margins around the actual field (title, labels, ruler, legend).
// IMG_FIELD_BOUNDS defines where the green playing field sits within the image
// as fractions of the full image dimensions.  Tweak these if player circles
// don't align with the printed field markings.
const IMG_FIELD_BOUNDS = {
  left:   0.14,   // fraction from image left edge to field left sideline
  right:  0.86,   // fraction from image left edge to field right sideline
  top:    0.25,   // fraction from image top  edge to field top  sideline
  bottom: 0.76,   // fraction from image top  edge to field bottom sideline
};

// Logical field coordinate system — unchanged from the original drawn field.
// x: 0 (left end line) → 110 (right end line)
// y: 0 (top sideline)  →  60 (bottom sideline)
const FIELD_YARDS = { w: 110, h: 60 };

// Returns a Promise that resolves to a fieldInfo object once the image has loaded.
function drawField(canvas, containerW, containerH) {
  return new Promise(resolve => {
    const padding = 16;

    fabric.Image.fromURL('./assets/field-diagram.jpg', (img) => {
      if (!img) { console.error('Field image failed to load'); resolve(null); return; }

      // Scale image to fill the available area while preserving aspect ratio
      const imgAspect = img.width / img.height;
      const availW = containerW - padding * 2;
      const availH = containerH - padding * 2;

      let displayW, displayH;
      if (availW / availH > imgAspect) {
        displayH = availH;
        displayW = availH * imgAspect;
      } else {
        displayW = availW;
        displayH = availW / imgAspect;
      }

      const imgLeft = (containerW - displayW) / 2;
      const imgTop  = (containerH - displayH) / 2;

      // Convert image-fraction bounds → canvas pixel bounds of the playing field
      const fieldLeft   = imgLeft + IMG_FIELD_BOUNDS.left   * displayW;
      const fieldRight  = imgLeft + IMG_FIELD_BOUNDS.right  * displayW;
      const fieldTop    = imgTop  + IMG_FIELD_BOUNDS.top    * displayH;
      const fieldBottom = imgTop  + IMG_FIELD_BOUNDS.bottom * displayH;

      const fieldW = fieldRight - fieldLeft;
      const fieldH = fieldBottom - fieldTop;
      const scaleX = fieldW / FIELD_YARDS.w;
      const scaleY = fieldH / FIELD_YARDS.h;
      const scale  = Math.min(scaleX, scaleY);

      img.set({
        left: imgLeft,
        top:  imgTop,
        scaleX: displayW / img.width,
        scaleY: displayH / img.height,
        selectable: false,
        evented: false,
        _isFieldObject: true,
      });

      canvas.add(img);
      canvas.sendToBack(img);
      canvas.renderAll();

      // Coordinate helpers — used by app.js for formation placement
      const fx = x => fieldLeft + x * scaleX;
      const fy = y => fieldTop  + y * scaleY;
      const s  = v => v * scale;

      resolve({
        fieldW, fieldH,
        offsetX: fieldLeft,
        offsetY: fieldTop,
        scale, scaleX, scaleY,
        fx, fy, s,
        fieldObjects: [img],
      });
    });
  });
}
