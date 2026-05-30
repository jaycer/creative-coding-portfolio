import { useEffect, useRef, useState, useCallback } from "react";

// ============================================================
// SHADER LIBRARY — add your own layers here
// Each shader receives: iTime, iResolution, iMouse, uPrev (previous layer texture)
// ============================================================

const SHADERS = {
  plasma: {
    name: "Plasma",
    color: "#ff6b35",
    frag: `
      precision highp float;
      uniform float iTime;
      uniform vec2 iResolution;
      uniform vec2 iMouse;
      varying vec2 vUv;

      float plasma(vec2 uv, float t) {
        float v = 0.0;
        v += sin(uv.x * 6.0 + t);
        v += sin(uv.y * 4.0 + t * 0.8);
        v += sin((uv.x + uv.y) * 5.0 + t * 1.2);
        float cx = uv.x + 0.5 * sin(t * 0.5);
        float cy = uv.y + 0.5 * cos(t * 0.3);
        v += sin(sqrt(cx*cx + cy*cy) * 8.0 + t);
        return v;
      }

      void main() {
        vec2 uv = vUv * 2.0 - 1.0;
        uv.x *= iResolution.x / iResolution.y;
        float v = plasma(uv, iTime * 0.6);
        vec3 col = vec3(
          sin(v * 3.14159) * 0.5 + 0.5,
          sin(v * 3.14159 + 2.094) * 0.5 + 0.5,
          sin(v * 3.14159 + 4.189) * 0.5 + 0.5
        );
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  },

  voronoi: {
    name: "Voronoi",
    color: "#00d4ff",
    frag: `
      precision highp float;
      uniform float iTime;
      uniform vec2 iResolution;
      uniform vec2 iMouse;
      varying vec2 vUv;

      vec2 hash2(vec2 p) {
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453);
      }

      void main() {
        vec2 uv = vUv * 5.0;
        vec2 p = floor(uv);
        vec2 f = fract(uv);
        float minDist = 9.0;
        vec2 minPoint = vec2(0.0);

        for (int j = -1; j <= 1; j++) {
          for (int i = -1; i <= 1; i++) {
            vec2 b = vec2(float(i), float(j));
            vec2 r = b + hash2(p + b) * 0.5 + 0.5 * sin(iTime * 0.5 + 6.28 * hash2(p + b));
            r -= f;
            float d = dot(r, r);
            if (d < minDist) { minDist = d; minPoint = b + p; }
          }
        }

        float dist = sqrt(minDist);
        vec3 col = vec3(
          0.1 + 0.9 * dist,
          0.3 + 0.7 * (1.0 - dist),
          0.6 + 0.4 * sin(dist * 6.28 + iTime)
        );
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  },

  warp: {
    name: "Domain Warp",
    color: "#c084fc",
    frag: `
      precision highp float;
      uniform float iTime;
      uniform vec2 iResolution;
      varying vec2 vUv;

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5);
        float b = fract(sin(dot(i + vec2(1,0), vec2(127.1, 311.7))) * 43758.5);
        float c = fract(sin(dot(i + vec2(0,1), vec2(127.1, 311.7))) * 43758.5);
        float d = fract(sin(dot(i + vec2(1,1), vec2(127.1, 311.7))) * 43758.5);
        return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
      }

      float fbm(vec2 p) {
        float v = 0.0; float a = 0.5;
        for (int i = 0; i < 5; i++) {
          v += a * noise(p); p *= 2.0; a *= 0.5;
        }
        return v;
      }

      void main() {
        vec2 uv = vUv * 3.0;
        float t = iTime * 0.2;
        vec2 q = vec2(fbm(uv + t), fbm(uv + vec2(1.7, 9.2) + t));
        vec2 r = vec2(fbm(uv + 4.0*q + vec2(1.7,9.2) + t*0.5),
                      fbm(uv + 4.0*q + vec2(8.3,2.8) + t*0.5));
        float f = fbm(uv + 4.0 * r);
        vec3 col = mix(
          vec3(0.05, 0.02, 0.15),
          mix(vec3(0.4, 0.1, 0.6), vec3(0.9, 0.5, 0.1), clamp(f*f*4.0, 0.0, 1.0)),
          clamp(f * 2.0, 0.0, 1.0)
        );
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  },

  // COMPOSITE LAYER — reads from uPrev texture
  composite: {
    name: "Composite",
    color: "#4ade80",
    isComposite: true,
    frag: `
      precision highp float;
      uniform float iTime;
      uniform vec2 iResolution;
      uniform sampler2D uPrev;
      varying vec2 vUv;

      void main() {
        vec4 prev = texture2D(uPrev, vUv);
        // Invert + hue rotate over time
        vec3 col = prev.rgb;
        float angle = iTime * 0.3;
        float c = cos(angle), s = sin(angle);
        mat3 hue = mat3(
          0.213+c*0.787-s*0.213, 0.715-c*0.715-s*0.715, 0.072-c*0.072+s*0.928,
          0.213-c*0.213+s*0.143, 0.715+c*0.285+s*0.140, 0.072-c*0.072-s*0.283,
          0.213-c*0.213-s*0.787, 0.715-c*0.715+s*0.715, 0.072+c*0.928+s*0.072
        );
        col = hue * col;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  },
};

// ============================================================
// VERTEX SHADER (shared)
// ============================================================
const VERT = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

// ============================================================
// WebGL helpers
// ============================================================
function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function createProgram(gl, fragSrc) {
  const vert = compileShader(gl, gl.VERTEX_SHADER, VERT);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vert || !frag) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

function createFBO(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fb };
}

// ============================================================
// Main compositor component
// ============================================================
export default function ShaderCompositor() {
  const canvasRef = useRef(null);
  const stateRef = useRef(null);
  const animRef = useRef(null);
  const mouseRef = useRef([0, 0]);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const canvasWrapRef = useRef(null);

  const toggleFullscreen = useCallback(() => {
    const el = canvasWrapRef.current;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.() || el.webkitRequestFullscreen?.();
    } else {
      document.exitFullscreen?.() || document.webkitExitFullscreen?.();
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  const [layers, setLayers] = useState([
    { id: "plasma", opacity: 1.0, blendMode: "add", enabled: true },
    { id: "voronoi", opacity: 0.6, blendMode: "screen", enabled: true },
    { id: "warp", opacity: 0.5, blendMode: "multiply", enabled: false },
    { id: "composite", opacity: 1.0, blendMode: "normal", enabled: false },
  ]);
  const [fps, setFps] = useState(0);
  const layersRef = useRef(layers);
  layersRef.current = layers;

  // Init WebGL
  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
    if (!gl) return;

    // Fullscreen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    // Compile all programs
    const programs = {};
    for (const [key, shader] of Object.entries(SHADERS)) {
      programs[key] = createProgram(gl, shader.frag);
    }

    // FBOs (double-buffered: ping-pong)
    const w = canvas.width, h = canvas.height;
    const fbos = [createFBO(gl, w, h), createFBO(gl, w, h)];

    stateRef.current = { gl, programs, fbos, buf, w, h };

    const startTime = performance.now();
    let lastFpsTime = startTime;
    let frames = 0;

    function drawLayer(prog, fboTarget, prevTex, time, mouse, w, h) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboTarget);
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog);

      const posLoc = gl.getAttribLocation(prog, "aPosition");
      gl.bindBuffer(gl.ARRAY_BUFFER, stateRef.current.buf);
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      const tLoc = gl.getUniformLocation(prog, "iTime");
      const rLoc = gl.getUniformLocation(prog, "iResolution");
      const mLoc = gl.getUniformLocation(prog, "iMouse");
      const pLoc = gl.getUniformLocation(prog, "uPrev");

      if (tLoc) gl.uniform1f(tLoc, time);
      if (rLoc) gl.uniform2f(rLoc, w, h);
      if (mLoc) gl.uniform2f(mLoc, mouse[0], mouse[1]);
      if (pLoc && prevTex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, prevTex);
        gl.uniform1i(pLoc, 0);
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // Final blit to screen with opacity + blendmode
    const blitFrag = `
      precision highp float;
      uniform sampler2D uTex;
      uniform sampler2D uBase;
      uniform float uOpacity;
      uniform int uBlend;
      varying vec2 vUv;
      void main() {
        vec4 src = texture2D(uTex, vUv);
        vec4 dst = texture2D(uBase, vUv);
        vec3 col;
        if (uBlend == 0) col = src.rgb; // normal
        else if (uBlend == 1) col = clamp(dst.rgb + src.rgb, 0.0, 1.0); // add
        else if (uBlend == 2) col = 1.0 - (1.0-dst.rgb)*(1.0-src.rgb); // screen
        else if (uBlend == 3) col = dst.rgb * src.rgb; // multiply
        else col = src.rgb;
        gl_FragColor = vec4(mix(dst.rgb, col, uOpacity), 1.0);
      }
    `;
    const blitProg = createProgram(gl, blitFrag);

    // Accumulation FBO
    const accFBOs = [createFBO(gl, w, h), createFBO(gl, w, h)];

    function render() {
      const now = performance.now();
      const time = (now - startTime) / 1000;
      frames++;
      if (now - lastFpsTime > 500) {
        setFps(Math.round(frames / ((now - lastFpsTime) / 1000)));
        frames = 0;
        lastFpsTime = now;
      }

      const activeLayers = layersRef.current.filter(l => l.enabled);
      let ping = 0;

      // Clear acc
      gl.bindFramebuffer(gl.FRAMEBUFFER, accFBOs[0].fb);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      let prevLayerTex = null;

      for (let i = 0; i < activeLayers.length; i++) {
        const layer = activeLayers[i];
        const prog = programs[layer.id];
        if (!prog) continue;

        // Render layer to fbo
        drawLayer(prog, fbos[ping].fb, prevLayerTex, time, mouseRef.current, w, h);
        prevLayerTex = fbos[ping].tex;
        ping = 1 - ping;

        // Blit into accumulation buffer with blend+opacity
        const blendMap = { normal: 0, add: 1, screen: 2, multiply: 3 };
        const blendInt = blendMap[layer.blendMode] ?? 0;

        gl.bindFramebuffer(gl.FRAMEBUFFER, accFBOs[1].fb);
        gl.viewport(0, 0, w, h);
        gl.useProgram(blitProg);

        const posLoc = gl.getAttribLocation(blitProg, "aPosition");
        gl.bindBuffer(gl.ARRAY_BUFFER, stateRef.current.buf);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, prevLayerTex);
        gl.uniform1i(gl.getUniformLocation(blitProg, "uTex"), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, accFBOs[0].tex);
        gl.uniform1i(gl.getUniformLocation(blitProg, "uBase"), 1);

        gl.uniform1f(gl.getUniformLocation(blitProg, "uOpacity"), layer.opacity);
        gl.uniform1i(gl.getUniformLocation(blitProg, "uBlend"), blendInt);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // Swap acc
        [accFBOs[0], accFBOs[1]] = [accFBOs[1], accFBOs[0]];
      }

      // Final blit to canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(blitProg);

      const posLoc = gl.getAttribLocation(blitProg, "aPosition");
      gl.bindBuffer(gl.ARRAY_BUFFER, stateRef.current.buf);
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, accFBOs[0].tex);
      gl.uniform1i(gl.getUniformLocation(blitProg, "uTex"), 0);

      // blank base for final
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, accFBOs[0].tex);
      gl.uniform1i(gl.getUniformLocation(blitProg, "uBase"), 1);
      gl.uniform1f(gl.getUniformLocation(blitProg, "uOpacity"), 1.0);
      gl.uniform1i(gl.getUniformLocation(blitProg, "uBlend"), 0);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      animRef.current = requestAnimationFrame(render);
    }

    animRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  // Mouse tracking
  const handleMouseMove = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    mouseRef.current = [
      e.clientX - rect.left,
      canvasRef.current.height - (e.clientY - rect.top),
    ];
  }, []);

  const updateLayer = (id, key, val) => {
    setLayers(prev => prev.map(l => l.id === id ? { ...l, [key]: val } : l));
  };

  const moveLayer = (idx, dir) => {
    setLayers(prev => {
      const next = [...prev];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  };

  const BLEND_MODES = ["normal", "add", "screen", "multiply"];

  return (
    <div style={{
      display: "flex", height: "100vh", background: "#0a0a0c",
      fontFamily: "'IBM Plex Mono', 'Courier New', monospace",
      color: "#e0e0e0", overflow: "hidden"
    }}>
      {/* Canvas */}
      <div ref={canvasWrapRef} style={{
        flex: 1, position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#0a0a0c"
      }}>
        <canvas
          ref={canvasRef}
          width={800} height={600}
          onMouseMove={handleMouseMove}
          style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
        />
        <div style={{
          position: "absolute", top: 14, left: 18,
          fontSize: 11, color: "rgba(255,255,255,0.3)", letterSpacing: "0.12em"
        }}>
          COMPOSITOR — {fps} FPS
        </div>
        <button
          onClick={toggleFullscreen}
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          style={{
            position: "absolute", top: 10, right: 14,
            background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 4, color: "rgba(255,255,255,0.4)", cursor: "pointer",
            padding: "5px 8px", display: "flex", alignItems: "center", justifyContent: "center",
            transition: "all 0.15s", fontSize: 13, lineHeight: 1
          }}
          onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.12)"; e.currentTarget.style.color = "#fff"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; e.currentTarget.style.color = "rgba(255,255,255,0.4)"; }}
        >
          {isFullscreen ? "✕" : "⤢"}
          <span style={{ fontSize: 9, letterSpacing: "0.12em", marginLeft: 6 }}>
            {isFullscreen ? "EXIT" : "FULLSCREEN"}
          </span>
        </button>
      </div>

      {/* Panel */}
      {!isFullscreen && <div style={{
        width: 280, background: "#111114", borderLeft: "1px solid #222228",
        display: "flex", flexDirection: "column", overflowY: "auto"
      }}>
        <div style={{
          padding: "18px 20px 14px", borderBottom: "1px solid #1e1e26",
          fontSize: 10, letterSpacing: "0.2em", color: "#888"
        }}>
          SHADER LAYERS
        </div>

        <div style={{ padding: "10px 12px", flex: 1 }}>
          {layers.map((layer, idx) => {
            const meta = SHADERS[layer.id];
            if (!meta) return null;
            return (
              <div key={layer.id} style={{
                marginBottom: 8, border: `1px solid ${layer.enabled ? meta.color + "44" : "#222"}`,
                borderRadius: 4, overflow: "hidden",
                opacity: layer.enabled ? 1 : 0.75,
                transition: "opacity 0.2s, border-color 0.2s"
              }}>
                {/* Header */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 10px", background: layer.enabled ? meta.color + "18" : "#16161a",
                  cursor: "pointer"
                }} onClick={() => updateLayer(layer.id, "enabled", !layer.enabled)}>
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: layer.enabled ? meta.color : "#333",
                    boxShadow: layer.enabled ? `0 0 6px ${meta.color}` : "none",
                    transition: "all 0.2s", flexShrink: 0
                  }} />
                  <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", flex: 1, color: layer.enabled ? "#eee" : "#bbb" }}>
                    {meta.name.toUpperCase()}
                    {meta.isComposite && <span style={{ marginLeft: 6, fontSize: 9, color: "#4ade80", opacity: 0.7 }}>FX</span>}
                  </span>
                  <div style={{ display: "flex", gap: 2 }}>
                    <button onClick={e => { e.stopPropagation(); moveLayer(idx, -1); }} style={btnStyle}>↑</button>
                    <button onClick={e => { e.stopPropagation(); moveLayer(idx, 1); }} style={btnStyle}>↓</button>
                  </div>
                </div>

                {layer.enabled && (
                  <div style={{ padding: "8px 10px 10px", background: "#0e0e12" }}>
                    {/* Opacity */}
                    <label style={labelStyle}>OPACITY</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="range" min={0} max={1} step={0.01}
                        value={layer.opacity}
                        onChange={e => updateLayer(layer.id, "opacity", parseFloat(e.target.value))}
                        style={sliderStyle(meta.color)}
                      />
                      <span style={{ fontSize: 10, color: "#999", width: 30, textAlign: "right" }}>
                        {Math.round(layer.opacity * 100)}
                      </span>
                    </div>

                    {/* Blend mode */}
                    <label style={{ ...labelStyle, marginTop: 8 }}>BLEND</label>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {BLEND_MODES.map(mode => (
                        <button key={mode}
                          onClick={() => updateLayer(layer.id, "blendMode", mode)}
                          style={{
                            padding: "3px 7px", fontSize: 9, borderRadius: 2,
                            border: `1px solid ${layer.blendMode === mode ? meta.color : "#333"}`,
                            background: layer.blendMode === mode ? meta.color + "22" : "transparent",
                            color: layer.blendMode === mode ? meta.color : "#aaa",
                            cursor: "pointer", letterSpacing: "0.08em", textTransform: "uppercase",
                            transition: "all 0.15s"
                          }}>
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: "12px 16px", borderTop: "1px solid #1a1a20",
          fontSize: 9, color: "#888", lineHeight: 1.8, letterSpacing: "0.08em"
        }}>
          <div style={{ color: "#aaa", marginBottom: 4, fontSize: 10 }}>HOW IT WORKS</div>
          Each layer renders to an FBO.<br />
          Outputs chain as <span style={{ color: "#bbb" }}>uPrev</span> uniforms.<br />
          Blend modes composite in screen space.<br />
          Mouse → <span style={{ color: "#bbb" }}>iMouse</span> uniform.
        </div>
      </div>}
    </div>
  );
}

const btnStyle = {
  width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center",
  background: "transparent", border: "1px solid #333", borderRadius: 2,
  color: "#888", fontSize: 11, cursor: "pointer", padding: 0,
  lineHeight: 1
};

const labelStyle = {
  display: "block", fontSize: 9, letterSpacing: "0.15em",
  color: "#aaa", marginBottom: 4, marginTop: 2
};

const sliderStyle = (color) => ({
  flex: 1, appearance: "none", height: 2,
  background: `linear-gradient(to right, ${color}, ${color}44)`,
  outline: "none", cursor: "pointer", borderRadius: 1,
  accentColor: color
});
