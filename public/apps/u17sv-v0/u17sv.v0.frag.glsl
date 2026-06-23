#ifdef GL_ES
precision highp float;
#endif

#define M_PI 3.1415926535897932384626433832795

uniform float time;
uniform vec2 mouse;
uniform vec2 resolution;

uniform float factorA; // 15.0
uniform float factorB; // 80.0
uniform float factorC; // 10.0
uniform float factorD; // 25.0
uniform float factorE; // 40.0
uniform float factorF; //  5.0
uniform float factorG; // 35.0
uniform float factorH; //  3.5
uniform float factorI; //  0.05
uniform float factorJ; //  0.5
uniform float fRotation;
uniform float fPositionDividend; // 4.0
uniform float fGlitch;

mat2 rotate(float angle) {
  angle /= 2.0;
  
  return mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
  
}

vec3 glitch(float amt, vec3 colorToGlitch) {
  
  vec2 offset = vec2(amt, 0.0);
  colorToGlitch.r = (0.01*offset.x) + colorToGlitch.b;
  colorToGlitch.b = (0.01*offset.x) - colorToGlitch.g;
  colorToGlitch.g = (0.01*offset.x) + colorToGlitch.r;
  return colorToGlitch;
  
}

// https://gist.github.com/mairod/a75e7b44f68110e1576d77419d608786
vec3 hueShift(vec3 color, float hueAdjustRadians) {

    const vec3  kRGBToYPrime = vec3(0.299, 0.587, 0.114);
    const vec3  kRGBToI      = vec3(0.596, -0.275, -0.321);
    const vec3  kRGBToQ      = vec3(0.212, -0.523, 0.311);

    const vec3  kYIQToR     = vec3(1.0, 0.956, 0.621);
    const vec3  kYIQToG     = vec3(1.0, -0.272, -0.647);
    const vec3  kYIQToB     = vec3(1.0, -1.107, 1.704);

    float   YPrime  = dot(color, kRGBToYPrime);
    float   I       = dot(color, kRGBToI);
    float   Q       = dot(color, kRGBToQ);
    float   hue     = atan(Q, I);
    float   chroma  = sqrt(I * I + Q * Q);

    hue += hueAdjustRadians;

    Q = chroma * sin(hue);
    I = chroma * cos(hue);

    vec3 yIQ = vec3(YPrime, I, Q);

    return vec3(dot(yIQ, kYIQToR), dot(yIQ, kYIQToG), dot(yIQ, kYIQToB));

}

void main() {

  vec2 position = (gl_FragCoord.xy / resolution.xy) + mouse / fPositionDividend; 
  position = rotate(fRotation) * position;
  
  // origin: https://glslsandbox.com/e

  float color = 0.0;
  color += sin(position.x * cos(time / factorA) * factorB) + cos(position.y * cos(time / factorA) * factorC);

  //color += sin(position.x * sin(time / factorA) * factorE) + cos(position.y * sin(time / factorA) * factorC);
  color += cos(position.y * sin(time / factorH) * factorE) + cos(position.y * sin(time / factorA) * factorC);

  //color += sin(position.y * tan(time / factorC) * factorE) + cos(position.x * sin(time / factorD) * factorE);

  //color += sin(position.x * sin(time / factorF) * factorC) + sin(position.y * sin(time / factorG) * factorB);
  // makes boxes
  //color += tan(position.x * cos(time / factorF) * factorC) + tan(position.y * sin(time / factorG) * factorB);
  color += sin(position.x * sin(time / factorF) * factorC) + sin(position.y * sin(time / factorG) * fGlitch);

  //color *= sin(time / factorC) * factorJ;
  //color *= tan(time / factorB) * factorJ;
  color *= atan(time / factorB) * factorJ;

  vec3 colorVec = vec3(color * factorI, color, sin(color + time / factorH) * 0.75);
  
  colorVec = glitch(fGlitch, colorVec);
  
  colorVec = hueShift(colorVec, fGlitch);
  
  gl_FragColor = vec4(colorVec, 1.0);

}

