// Fullscreen-quad pass-through. p5 feeds aPosition in [0,1] across the rect;
// we remap to clip space. (Same plumbing as bloon-boon / shader-particle-system.)
attribute vec3 aPosition;
attribute vec2 aTexCoord;

void main() {
  vec4 positionVec4 = vec4(aPosition, 1.0);
  positionVec4.xy = positionVec4.xy * 2.0 - 1.0;
  gl_Position = positionVec4;
}
