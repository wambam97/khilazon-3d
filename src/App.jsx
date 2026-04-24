import React, { useState, useEffect, Suspense, useMemo, useRef, useCallback } from 'react'
import { Canvas, useLoader, useThree, useFrame } from '@react-three/fiber'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader'
import { Environment, OrthographicCamera as DreiOrtho } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils'

// ─── Constants ────────────────────────────────────────────────────────────────
const ZOOM_DESKTOP = 28
const ZOOM_MOBILE  = 14   // 50% of desktop for portrait/mobile
const DEFAULT_PARAMS = { rotX: 0, rotY: 0, rotZ: 0, gap: 1.2 }
const ROW_HEIGHT = 7
const EASE = 0.18

// ─── Detect portrait/mobile ───────────────────────────────────────────────────
function useIsPortrait() {
  const [portrait, setPortrait] = useState(
    typeof window !== 'undefined' && window.innerWidth < window.innerHeight
  )
  useEffect(() => {
    const update = () => setPortrait(window.innerWidth < window.innerHeight)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return portrait
}

// ─── Letter ───────────────────────────────────────────────────────────────────
function Letter({ type, position, align, alefMetrics, targetRotX, targetRotY, targetRotZ }) {
  const obj = useLoader(OBJLoader, `/models/${type}.obj`)
  const groupRef = useRef()
  const currentRot = useRef({
    x: targetRotX * Math.PI / 180,
    y: targetRotY * Math.PI / 180,
    z: targetRotZ * Math.PI / 180,
  })

  useFrame(() => {
    const tx = targetRotX * Math.PI / 180
    const ty = targetRotY * Math.PI / 180
    const tz = targetRotZ * Math.PI / 180
    currentRot.current.x += (tx - currentRot.current.x) * EASE
    currentRot.current.y += (ty - currentRot.current.y) * EASE
    currentRot.current.z += (tz - currentRot.current.z) * EASE
    if (groupRef.current) {
      groupRef.current.rotation.set(
        currentRot.current.x,
        currentRot.current.y,
        currentRot.current.z
      )
    }
  })

  const material = useMemo(() => new THREE.MeshStandardMaterial({
    color: '#000000',
    roughness: 0.6,
    metalness: 1,
    envMapIntensity: 3.0,
  }), [])

  const processedObj = useMemo(() => {
    const clone = obj.clone()
    const box = new THREE.Box3().setFromObject(clone)
    const center = new THREE.Vector3()
    box.getCenter(center)

    clone.traverse((child) => {
      if (child.isMesh) {
        let geo = child.geometry.clone()
        geo.translate(-center.x, -center.y, -center.z)
        geo.deleteAttribute('normal')
        try { geo.deleteAttribute('uv') } catch (e) {}
        try { geo = mergeVertices(geo, 1e-4) } catch (e) {}
        geo.computeVertexNormals()
        geo.computeBoundingBox()
        const localBox = geo.boundingBox

        if (alefMetrics) {
          let offsetY = 0
          if (align === 'top') offsetY = localBox.max.y - alefMetrics.top
          else if (align === 'bottom') offsetY = localBox.min.y - alefMetrics.bottom
          geo.translate(0, -offsetY, 0)
        }
        child.geometry = geo
        child.material = material
      }
    })
    return clone
  }, [obj, align, alefMetrics, material])

  return (
    <group position={position}>
      <group ref={groupRef}>
        <primitive object={processedObj} />
      </group>
    </group>
  )
}

// ─── Width cache + probe ──────────────────────────────────────────────────────
const widthCache = {}

function LetterWidthProbe({ type, onDone }) {
  const obj = useLoader(OBJLoader, `/models/${type}.obj`)
  useEffect(() => {
    if (widthCache[type] !== undefined) { onDone(); return }
    const box = new THREE.Box3().setFromObject(obj)
    const size = new THREE.Vector3()
    box.getSize(size)
    widthCache[type] = size.x
    onDone()
  }, [obj])
  return null
}

// ─── Letter scene ─────────────────────────────────────────────────────────────
function LetterScene({ lines, alefMetrics, rotX, rotY, rotZ, gap, zoom }) {
  const { size } = useThree()
  const visibleWidth = size.width / zoom

  const allRows = useMemo(() => {
    const result = []
    for (const line of lines) {
      let currentRow = []
      let currentWidth = 0
      for (const token of line) {
        if (token === 'space') {
          const sw = widthCache['space'] ?? gap * 1.5
          currentRow.push({ type: 'space', w: sw })
          currentWidth += sw
          continue
        }
        const w = widthCache[token] ?? gap * 2
        const needed = currentRow.length === 0 ? w : gap + w
        if (currentRow.length > 0 && currentWidth + needed > visibleWidth * 0.92) {
          result.push(currentRow)
          currentRow = [{ type: token, w }]
          currentWidth = w
        } else {
          currentRow.push({ type: token, w })
          currentWidth += needed
        }
      }
      result.push(currentRow)
    }
    return result
  }, [lines, gap, visibleWidth])

  const totalHeight = (allRows.length - 1) * ROW_HEIGHT
  const startY = totalHeight / 2

  return (
    <>
      {allRows.map((row, rowIndex) => {
        const y = startY - rowIndex * ROW_HEIGHT
        let rowTotalWidth = 0
        row.forEach((tok, i) => { rowTotalWidth += tok.w + (i > 0 ? gap : 0) })
        let curX = rowTotalWidth / 2

        return row.map((tok, colIndex) => {
          const hw = tok.w / 2
          const x = curX - hw
          curX = curX - tok.w - gap
          if (tok.type === 'space') return <group key={`${rowIndex}-${colIndex}`} position={[x, y, 0]} />
          const topAligned = ['2','3','4','5','6','7','8','9','10','20','21','50','51','60','80','81','91','100','200','300','400']
          const bottomAligned = ['30','40','41','70','90']
          let align = 'center'
          if (topAligned.includes(tok.type)) align = 'top'
          if (bottomAligned.includes(tok.type)) align = 'bottom'
          return (
            <Letter
              key={`${rowIndex}-${colIndex}`}
              type={tok.type}
              alefMetrics={alefMetrics}
              position={[x, y, 0]}
              align={align}
              targetRotX={rotX}
              targetRotY={rotY}
              targetRotZ={rotZ}
            />
          )
        })
      })}
    </>
  )
}

// ─── Lights ───────────────────────────────────────────────────────────────────
function Lights() {
  return (
    <>
      <ambientLight intensity={0.05} />
      <directionalLight position={[0, 0, -10]} intensity={6} color="#ffffff" />
      <directionalLight position={[0, 8, -8]} intensity={3} color="#ddeeff" />
      <directionalLight position={[0, 0, 10]} intensity={0.08} color="#ffffff" />
    </>
  )
}

// ─── Cube gizmo ───────────────────────────────────────────────────────────────
function CubeScene({ rotX, rotY, rotZ, onRotate }) {
  const meshRef = useRef()
  const isDragging = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })
  const quatRef = useRef(new THREE.Quaternion())

  useEffect(() => {
    if (!isDragging.current) {
      const e = new THREE.Euler(rotX * Math.PI / 180, rotY * Math.PI / 180, rotZ * Math.PI / 180, 'XYZ')
      quatRef.current.setFromEuler(e)
      if (meshRef.current) meshRef.current.quaternion.copy(quatRef.current)
    }
  }, [rotX, rotY, rotZ])

  const edgesGeo = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(1.2, 1.2, 1.2)), [])

  const handlePointerDown = useCallback((e) => {
    e.stopPropagation()
    isDragging.current = true
    lastMouse.current = { x: e.clientX, y: e.clientY }
  }, [])

  const handlePointerMove = useCallback((e) => {
    if (!isDragging.current) return
    const dx = e.clientX - lastMouse.current.x
    const dy = e.clientY - lastMouse.current.y
    lastMouse.current = { x: e.clientX, y: e.clientY }
    const s = 0.5 * Math.PI / 180
    quatRef.current
      .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * s))
      .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * s))
    if (meshRef.current) meshRef.current.quaternion.copy(quatRef.current)
    const euler = new THREE.Euler().setFromQuaternion(quatRef.current, 'XYZ')
    onRotate({
      x: Math.round(euler.x * 180 / Math.PI),
      y: Math.round(euler.y * 180 / Math.PI),
      z: Math.round(euler.z * 180 / Math.PI),
    })
  }, [onRotate])

  const handlePointerUp = useCallback(() => { isDragging.current = false }, [])

  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [handlePointerMove, handlePointerUp])

  return (
    <lineSegments ref={meshRef} geometry={edgesGeo} onPointerDown={handlePointerDown}>
      <lineBasicMaterial color="#ffffff" />
    </lineSegments>
  )
}

// ─── Glass slider ─────────────────────────────────────────────────────────────
function GlassSlider({ value, min, max, step = 1, onChange }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div style={{ position: 'relative', height: 18, display: 'flex', alignItems: 'center', flex: 1 }}>
      <div style={{ position: 'absolute', left: 0, right: 0, height: 1.5, background: 'rgba(255,255,255,0.15)', borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: 0, width: `${pct}%`, height: 1.5, background: 'rgba(255,255,255,0.55)', borderRadius: 2 }} />
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ position: 'absolute', left: 0, right: 0, width: '100%', opacity: 0, cursor: 'pointer', height: 18, margin: 0 }} />
      <div style={{
        position: 'absolute', left: `calc(${pct}% - 7px)`,
        width: 14, height: 14, borderRadius: '50%',
        background: 'rgba(255,255,255,0.92)',
        boxShadow: '0 0 6px rgba(255,255,255,0.35)',
        pointerEvents: 'none',
      }} />
    </div>
  )
}

// ─── Draggable panel — clamped to screen bounds ───────────────────────────────
const PANEL_W = 290
const PANEL_H = 260  // approximate panel height for clamping

function DraggablePanel({ children, initialPos }) {
  const dragState = useRef({ dragging: false, ox: 0, oy: 0 })
  const [pos, setPos] = useState(initialPos)

  // Clamp helper
  const clamp = useCallback((x, y) => ({
    x: Math.max(0, Math.min(window.innerWidth - PANEL_W, x)),
    y: Math.max(0, Math.min(window.innerHeight - PANEL_H, y)),
  }), [])

  // Re-clamp on window resize so panel never hides off-screen
  useEffect(() => {
    const onResize = () => setPos(p => clamp(p.x, p.y))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  const onMouseDown = (e) => {
    if (e.target.closest('[data-nodrag]')) return
    dragState.current = { dragging: true, ox: e.clientX - pos.x, oy: e.clientY - pos.y }
    e.preventDefault()
  }

  useEffect(() => {
    const onMove = (e) => {
      if (!dragState.current.dragging) return
      setPos(clamp(e.clientX - dragState.current.ox, e.clientY - dragState.current.oy))
    }
    const onUp = () => { dragState.current.dragging = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [clamp])

  return (
    <div onMouseDown={onMouseDown}
      style={{ position: 'absolute', left: pos.x, top: pos.y, cursor: 'grab', userSelect: 'none' }}>
      {children}
    </div>
  )
}

// ─── Small UI button ──────────────────────────────────────────────────────────
function PanelBtn({ onClick, children }) {
  const base = { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.38)' }
  const hover = { background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff' }
  const [h, setH] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        ...(h ? hover : base),
        padding: '3px 9px', borderRadius: 6,
        cursor: 'pointer', fontFamily: 'monospace', fontSize: 8,
        letterSpacing: '0.1em', textTransform: 'uppercase',
        flexShrink: 0, transition: 'all 0.15s',
      }}
    >{children}</button>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [lines, setLines] = useState([[]])
  const [alefMetrics, setAlefMetrics] = useState(null)
  const [params, setParams] = useState(DEFAULT_PARAMS)
  const [, forceUpdate] = useState(0)
  const [panelReady, setPanelReady] = useState(false)
  const [initPos, setInitPos] = useState({ x: 0, y: 0 })
  const isPortrait = useIsPortrait()
  const zoom = isPortrait ? ZOOM_MOBILE : ZOOM_DESKTOP

  const alefObj = useLoader(OBJLoader, '/models/1.obj')
  useEffect(() => {
    if (alefObj) {
      const box = new THREE.Box3().setFromObject(alefObj)
      const size = new THREE.Vector3()
      box.getSize(size)
      setAlefMetrics({ top: size.y / 2, bottom: -size.y / 2 })
    }
  }, [alefObj])

  useEffect(() => {
    const x = Math.max(0, Math.min(window.innerWidth - PANEL_W, window.innerWidth / 2 - PANEL_W / 2))
    const y = Math.max(0, Math.min(window.innerHeight - PANEL_H, window.innerHeight - PANEL_H - 28))
    setInitPos({ x, y })
    setPanelReady(true)
  }, [])

  const allTokenTypes = useMemo(() => {
    const types = new Set()
    lines.forEach(line => line.forEach(t => { if (t !== 'space') types.add(t) }))
    return [...types]
  }, [lines])

  const handleWidthDone = useCallback(() => { forceUpdate(n => n + 1) }, [])

  useEffect(() => {
    const keyMap = {
      'א': '1','ב': '2','ג': '3','ד': '4','ה': '5','ו': '6','ז': '7','ח': '8','ט': '9','י': '10',
      'כ': '20','ך': '21','ל': '30','מ': '40','ם': '41','נ': '50','ן': '51','ס': '60','ע': '70',
      'פ': '80','ף': '81','צ': '90','ץ': '91','ק': '100','ר': '200','ש': '300','ת': '400'
    }
    const handleKeyDown = (e) => {
      if (e.key === 'Enter') {
        setLines(prev => [...prev, []])
      } else if (keyMap[e.key]) {
        setLines(prev => { const n = prev.map(l => [...l]); n[n.length - 1].push(keyMap[e.key]); return n })
      } else if (e.key === ' ') {
        e.preventDefault()
        setLines(prev => { const n = prev.map(l => [...l]); n[n.length - 1].push('space'); return n })
      } else if (e.key === 'Backspace') {
        setLines(prev => {
          const n = prev.map(l => [...l])
          const last = n[n.length - 1]
          if (last.length > 0) n[n.length - 1] = last.slice(0, -1)
          else if (n.length > 1) n.pop()
          return n
        })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const set = key => val => setParams(p => ({ ...p, [key]: val }))

  const handleCubeRotate = useCallback(({ x, y, z }) => {
    setParams(p => ({
      ...p,
      rotX: Math.max(-180, Math.min(180, x)),
      rotY: Math.max(-180, Math.min(180, y)),
      rotZ: Math.max(-180, Math.min(180, z)),
    }))
  }, [])

  return (
    <>
      {/* Inject global style to kill any scroll/overflow at html+body level */}
      <style>{`
        html, body, #root {
          margin: 0; padding: 0;
          width: 100%; height: 100%;
          overflow: hidden;
          background: #000;
        }
      `}</style>

      <div style={{
        position: 'fixed',       /* fixed instead of relative — anchors to viewport exactly */
        top: 0, left: 0,
        width: '100%',           /* 100% of viewport, not 100vw which can include scrollbar */
        height: '100%',
        background: '#000',
        overflow: 'hidden',
      }}>

        {/* SVG grid — 100vh tall, width stretches to fill screen width */}
        <img src="/grid.svg" alt=""
          style={{
            position: 'absolute', top: 0, left: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            pointerEvents: 'none', zIndex: 0,
          }}
        />

        {/* 3D canvas */}
        <Canvas
          style={{ position: 'absolute', inset: 0, zIndex: 1 }}
          gl={{ alpha: true }}
          onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
        >
          <DreiOrtho makeDefault position={[0, 0, 100]} zoom={zoom} />
          <Suspense fallback={null}>
            {allTokenTypes.map(type => (
              <LetterWidthProbe key={type} type={type} onDone={handleWidthDone} />
            ))}
            <LetterScene
              lines={lines}
              alefMetrics={alefMetrics}
              rotX={params.rotX} rotY={params.rotY} rotZ={params.rotZ}
              gap={params.gap}
              zoom={zoom}
            />
            <Lights />
            <Environment preset="studio" background={false} />
          </Suspense>
          <EffectComposer>
            <Bloom intensity={2.2} luminanceThreshold={0.3} luminanceSmoothing={0.85} radius={0.85} />
          </EffectComposer>
        </Canvas>

        {/* Draggable panel */}
        {panelReady && (
          <DraggablePanel initialPos={initPos}>
            <div style={{
              width: PANEL_W,
              background: 'rgba(255,255,255,0.04)',
              backdropFilter: 'blur(20px) saturate(140%)',
              WebkitBackdropFilter: 'blur(20px) saturate(140%)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 20,
              padding: '16px 18px 14px',
              boxShadow: '0 8px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.07)',
              position: 'relative', zIndex: 10,
            }}>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginBottom: 16 }} data-nodrag>
                {['rotX', 'rotY', 'rotZ'].map(key => (
                  <GlassSlider key={key} value={params[key]} min={-180} max={180} onChange={set(key)} />
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'stretch', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }} data-nodrag>
                  {[['X', 'rotX'], ['Y', 'rotY'], ['Z', 'rotZ']].map(([label, key]) => (
                    <div key={key} style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 5 }}>
                      <span style={{ width: 12, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', fontSize: 11 }}>{label}</span>
                      <span style={{ color: 'rgba(255,255,255,0.75)', fontFamily: 'monospace', fontSize: 11 }}>{params[key]}°</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 10, paddingTop: 9, borderTop: '1px solid rgba(255,255,255,0.07)', flexWrap: 'nowrap' }}>
                    <span style={{ color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', flexShrink: 0 }}>Gap</span>
                    <GlassSlider value={params.gap} min={0} max={6} step={0.05} onChange={set('gap')} />
                    <span style={{ color: 'rgba(255,255,255,0.38)', fontFamily: 'monospace', fontSize: 9, flexShrink: 0, width: 22, textAlign: 'right' }}>{params.gap.toFixed(1)}</span>
                    {/* Reset params */}
                    <PanelBtn onClick={() => setParams(DEFAULT_PARAMS)}>Reset</PanelBtn>
                    {/* Clear text */}
                    <PanelBtn onClick={() => setLines([[]])}>Clear</PanelBtn>
                  </div>
                </div>

                {/* Cube */}
                <div data-nodrag style={{ flexShrink: 0, width: 72, height: 72, position: 'relative', alignSelf: 'center' }}>
                  <Canvas
                    style={{
                      position: 'absolute', top: '50%', left: '50%',
                      transform: 'translate(-50%, -50%)',
                      width: 150, height: 150,
                      background: 'transparent', cursor: 'grab',
                    }}
                    gl={{ alpha: true }}
                    orthographic
                    camera={{ zoom: 55, position: [0, 0, 10], near: 0.1, far: 100 }}
                  >
                    <CubeScene rotX={params.rotX} rotY={params.rotY} rotZ={params.rotZ} onRotate={handleCubeRotate} />
                  </Canvas>
                </div>
              </div>
            </div>
          </DraggablePanel>
        )}
      </div>
    </>
  )
}