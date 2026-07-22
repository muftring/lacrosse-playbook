// Wide 2D arrow drawing for Fabric.js
// Creates a filled polygon arrow shape

fabric.ArrowShape = fabric.util.createClass(fabric.Polygon, {
  type: 'ArrowShape',

  initialize: function(x1, y1, x2, y2, options) {
    options = options || {};
    this._x1 = x1;
    this._y1 = y1;
    this._x2 = x2;
    this._y2 = y2;

    const pts = ArrowShape.computePoints(x1, y1, x2, y2,
      options.shaftWidth || 12,
      options.headWidth || 28,
      options.headLength || 32
    );

    this.callSuper('initialize', pts, Object.assign({
      fill: options.fill || 'rgba(255,200,0,0.75)',
      stroke: options.stroke || 'rgba(255,200,0,1)',
      strokeWidth: 1.5,
      selectable: true,
      hasControls: true,
      lockScalingFlip: true,
    }, options));

    this.shaftWidth = options.shaftWidth || 12;
    this.headWidth = options.headWidth || 28;
    this.headLength = options.headLength || 32;
  },

  toObject: function() {
    return fabric.util.object.extend(this.callSuper('toObject'), {
      _x1: this._x1, _y1: this._y1,
      _x2: this._x2, _y2: this._y2,
      shaftWidth: this.shaftWidth,
      headWidth: this.headWidth,
      headLength: this.headLength
    });
  }
});

const ArrowShape = {
  computePoints: function(x1, y1, x2, y2, shaftW, headW, headLen) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return [{ x: x1, y: y1 }];

    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;

    const shaftEnd = Math.max(0, len - headLen);

    // 7-point arrowhead polygon
    return [
      { x: x1 + px * shaftW / 2, y: y1 + py * shaftW / 2 },
      { x: x1 + ux * shaftEnd + px * shaftW / 2, y: y1 + uy * shaftEnd + py * shaftW / 2 },
      { x: x1 + ux * shaftEnd + px * headW / 2, y: y1 + uy * shaftEnd + py * headW / 2 },
      { x: x2, y: y2 },
      { x: x1 + ux * shaftEnd - px * headW / 2, y: y1 + uy * shaftEnd - py * headW / 2 },
      { x: x1 + ux * shaftEnd - px * shaftW / 2, y: y1 + uy * shaftEnd - py * shaftW / 2 },
      { x: x1 - px * shaftW / 2, y: y1 - py * shaftW / 2 },
    ];
  }
};

fabric.ArrowShape.fromObject = function(object, callback) {
  callback && callback(new fabric.ArrowShape(
    object._x1, object._y1, object._x2, object._y2, object
  ));
};

// Helper: create arrow between two canvas points
function createArrow(x1, y1, x2, y2, color) {
  color = color || 'rgba(255,200,0,0.8)';
  return new fabric.ArrowShape(x1, y1, x2, y2, {
    fill: color,
    stroke: color.replace(/[\d.]+\)$/, '1)'),
    shaftWidth: 14,
    headWidth: 32,
    headLength: 36,
    _arrowObject: true
  });
}
