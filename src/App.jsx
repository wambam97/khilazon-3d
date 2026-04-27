import React, { useState, useEffect, Suspense, useMemo, useRef, useCallback } from 'react'
import { Canvas, useLoader, useThree, useFrame } from '@react-three/fiber'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader'
import { Environment, OrthographicCamera as DreiOrtho } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils'

// ─── Constants ────────────────────────────────────────────────────────────────
const ZOOM_DESKTOP = 28
const ZOOM_MOBILE  = 14
const DEFAULT_PARAMS = { rotX: 0, rotY: 0, rotZ: 0, gap: 1.2, leading: 7, size: 1.0 }
const EASE = 0.18
const PANEL_W = 240
const PANEL_H = 380

// Reverse map: model id → Hebrew character (for print footer)
const MODEL_TO_CHAR = {
  '1':'א','2':'ב','3':'ג','4':'ד','5':'ה','6':'ו','7':'ז','8':'ח','9':'ט','10':'י',
  '20':'כ','21':'ך','30':'ל','40':'מ','41':'ם','50':'נ','51':'ן','60':'ס','70':'ע',
  '80':'פ','81':'ף','90':'צ','91':'ץ','100':'ק','200':'ר','300':'ש','400':'ת',
}

// ─── Portrait detection ───────────────────────────────────────────────────────
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
function Letter({ type, position, align, alefMetrics, targetRotX, targetRotY, targetRotZ, letterScale }) {
  const obj = useLoader(OBJLoader, `/models/${type}.obj`)
  const groupRef = useRef()
  const currentRot = useRef({
    x: targetRotX * Math.PI / 180,
    y: targetRotY * Math.PI / 180,
    z: targetRotZ * Math.PI / 180,
  })
  const { invalidate } = useThree()

  useFrame(() => {
    const tx = targetRotX * Math.PI / 180
    const ty = targetRotY * Math.PI / 180
    const tz = targetRotZ * Math.PI / 180
    const dx = tx - currentRot.current.x
    const dy = ty - currentRot.current.y
    const dz = tz - currentRot.current.z
    currentRot.current.x += dx * EASE
    currentRot.current.y += dy * EASE
    currentRot.current.z += dz * EASE
    if (groupRef.current) {
      groupRef.current.rotation.set(
        currentRot.current.x,
        currentRot.current.y,
        currentRot.current.z
      )
    }
    if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001 || Math.abs(dz) > 0.0001) invalidate()
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
    <group position={position} scale={[letterScale, letterScale, letterScale]}>
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
function LetterScene({ lines, alefMetrics, rotX, rotY, rotZ, gap, leading, letterScale, zoom, textAlign }) {
  const { size } = useThree()
  const visibleWidth = size.width / zoom

  const allRows = useMemo(() => {
    const result = []
    for (const line of lines) {
      let currentRow = []
      let currentWidth = 0
      for (const token of line) {
        if (token === 'space') {
          const sw = (widthCache['space'] ?? gap * 1.5) * letterScale
          currentRow.push({ type: 'space', w: sw })
          currentWidth += sw
          continue
        }
        const w = (widthCache[token] ?? gap * 2) * letterScale
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
  }, [lines, gap, leading, letterScale, visibleWidth])

  const totalHeight = (allRows.length - 1) * leading
  const startY = totalHeight / 2
  const maxW = visibleWidth * 0.92

  return (
    <>
      {allRows.map((row, rowIndex) => {
        const y = startY - rowIndex * leading

        // Natural row width
        let rowTotalWidth = 0
        row.forEach((tok, i) => { rowTotalWidth += tok.w + (i > 0 ? gap : 0) })

        // For justify: spread letters to fill maxW by expanding gaps
        const isLastRow = rowIndex === allRows.length - 1
        let effectiveGap = gap
        if (textAlign === 'justify' && !isLastRow && row.length > 1) {
          const extraSpace = maxW - rowTotalWidth
          effectiveGap = gap + extraSpace / (row.length - 1)
        }

        // Compute start X based on alignment
        // Hebrew RTL: letters placed right→left from startX
        // "left" visually = first letter at screen-left = startX at left edge, curX goes further left → not possible
        // RTL layout: curX starts positive and decrements. Visual left = small positive startX. Visual right = large startX.
        let startX
        if (textAlign === 'right') {
          // Flush right: row starts at right edge (maxW/2), natural RTL direction
          startX = maxW / 2
        } else if (textAlign === 'left') {
          // Flush left: row ends at left edge (-maxW/2), so startX = -maxW/2 + rowTotalWidth
          startX = -maxW / 2 + rowTotalWidth
        } else {
          // center or justify: centered
          startX = rowTotalWidth / 2
          if (textAlign === 'justify' && !isLastRow && row.length > 1) {
            let jWidth = 0
            row.forEach((tok, i) => { jWidth += tok.w + (i > 0 ? effectiveGap : 0) })
            startX = jWidth / 2
          }
        }

        let curX = startX

        return row.map((tok, colIndex) => {
          const hw = tok.w / 2
          const x = curX - hw
          curX = curX - tok.w - effectiveGap
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
              letterScale={letterScale}
            />
          )
        })
      })}
    </>
  )
}

// ─── Shared mouse position ────────────────────────────────────────────────────
const mouseNorm = { x: 0, y: 0 }
let sphereInvalidate = null
if (typeof window !== 'undefined') {
  window.addEventListener('mousemove', (e) => {
    mouseNorm.x = (e.clientX / window.innerWidth)  * 2 - 1
    mouseNorm.y = (e.clientY / window.innerHeight) * 2 - 1
    sphereInvalidate?.()
  }, { passive: true })
}

// ─── Wireframe sphere (quad grid, no diagonal triangle edges) ─────────────────
function buildSphereEdgeGeo(radius = 32, widthSegs = 24, heightSegs = 16) {
  const positions = []
  const v = (theta, phi) => [
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ]
  for (let j = 1; j < heightSegs; j++) {
    const phi = (j / heightSegs) * Math.PI
    for (let i = 0; i < widthSegs; i++) {
      const t0 = (i / widthSegs) * Math.PI * 2
      const t1 = ((i + 1) / widthSegs) * Math.PI * 2
      positions.push(...v(t0, phi), ...v(t1, phi))
    }
  }
  for (let i = 0; i < widthSegs; i++) {
    const theta = (i / widthSegs) * Math.PI * 2
    for (let j = 0; j < heightSegs; j++) {
      const p0 = (j / heightSegs) * Math.PI
      const p1 = ((j + 1) / heightSegs) * Math.PI
      positions.push(...v(theta, p0), ...v(theta, p1))
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geo
}

function SphereWireframe({ isDark }) {
  const groupRef = useRef()
  const curY = useRef(0)
  const curX = useRef(0)
  const { invalidate } = useThree()
  const geo = useMemo(() => buildSphereEdgeGeo(32, 24, 16), [])
  const mat = useMemo(() => new THREE.LineBasicMaterial({
    color: isDark ? '#ffffff' : '#000000',
    transparent: true,
    opacity: isDark ? 0.28 : 0.18,
  }), [isDark])

  useEffect(() => {
    sphereInvalidate = invalidate
    return () => { sphereInvalidate = null }
  }, [invalidate])

  useFrame(() => {
    const tY = -mouseNorm.x * (5 * Math.PI / 180)
    const tX =  mouseNorm.y * (2.5 * Math.PI / 180)
    const dy = tY - curY.current
    const dx = tX - curX.current
    curY.current += dy * 0.022
    curX.current += dx * 0.022
    if (groupRef.current) {
      groupRef.current.rotation.y = curY.current
      groupRef.current.rotation.x = curX.current
    }
    if (Math.abs(dy) > 0.00005 || Math.abs(dx) > 0.00005) invalidate()
  })

  return (
    <group ref={groupRef}>
      <lineSegments geometry={geo} material={mat} />
    </group>
  )
}

function SphereCanvas({ isDark }) {
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 1.5]}
      style={{
        position: 'absolute',
        // Bleed 60px top and bottom beyond the container so it's visible
        // behind Safari's notch and address bar
        top: -60, bottom: -60, left: 0, right: 0,
        height: 'calc(100% + 120px)',
        zIndex: 0, pointerEvents: 'none',
      }}
      gl={{ alpha: true, antialias: false, powerPreference: 'low-power' }}
      onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
      camera={{ position: [0, 0, 0.001], fov: 75, near: 0.1, far: 300 }}
    >
      <SphereWireframe isDark={isDark} />
    </Canvas>
  )
}

// ─── Invalidator — triggers a render burst when params change ─────────────────
function Invalidator({ rotX, rotY, rotZ }) {
  const { invalidate } = useThree()
  useEffect(() => { invalidate() }, [rotX, rotY, rotZ, invalidate])
  return null
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
function CubeScene({ rotX, rotY, rotZ, onRotate, isDark }) {
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
      <lineBasicMaterial color={isDark ? '#ffffff' : '#000000'} />
    </lineSegments>
  )
}

// ─── Theme-aware tokens ───────────────────────────────────────────────────────
// All text/border/bg colours derived from isDark so light mode is fully inverted
function useThemeTokens(isDark) {
  return useMemo(() => ({
    text:        isDark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.75)',
    textDim:     isDark ? 'rgba(255,255,255,0.3)'  : 'rgba(0,0,0,0.35)',
    textFaint:   isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.25)',
    trackBg:     isDark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.13)',
    trackFill:   isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)',
    thumb:       isDark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.85)',
    thumbShadow: isDark ? 'rgba(255,255,255,0.3)'  : 'rgba(0,0,0,0.2)',
    divider:     isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.09)',
    btnBg:       isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)',
    btnBgHover:  isDark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.13)',
    btnBgActive: isDark ? 'rgba(255,255,255,0.2)'  : 'rgba(0,0,0,0.18)',
    btnBorder:   isDark ? 'rgba(255,255,255,0.1)'  : 'rgba(0,0,0,0.12)',
    btnText:     isDark ? 'rgba(255,255,255,0.38)' : 'rgba(0,0,0,0.45)',
    btnTextHov:  isDark ? '#ffffff'                : '#000000',
    panelBg:     isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)',
    panelBorder: isDark ? 'rgba(255,255,255,0.1)'  : 'rgba(0,0,0,0.12)',
  }), [isDark])
}

// ─── Glass slider (theme-aware) ───────────────────────────────────────────────
function GlassSlider({ value, min, max, step = 1, onChange, tk }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div style={{ position: 'relative', height: 18, display: 'flex', alignItems: 'center', flex: 1 }}>
      <div style={{ position: 'absolute', left: 0, right: 0, height: 1.5, background: tk.trackBg, borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: 0, width: `${pct}%`, height: 1.5, background: tk.trackFill, borderRadius: 2 }} />
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ position: 'absolute', left: 0, right: 0, width: '100%', opacity: 0, cursor: 'pointer', height: 18, margin: 0 }} />
      <div style={{
        position: 'absolute', left: `calc(${pct}% - 7px)`,
        width: 14, height: 14, borderRadius: '50%',
        background: tk.thumb,
        boxShadow: `0 0 6px ${tk.thumbShadow}`,
        pointerEvents: 'none',
      }} />
    </div>
  )
}

// ─── Panel button (theme-aware) ───────────────────────────────────────────────
function PanelBtn({ onClick, children, active, tk }) {
  const [h, setH] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        background: active ? tk.btnBgActive : h ? tk.btnBgHover : tk.btnBg,
        border: `1px solid ${tk.btnBorder}`,
        color: active || h ? tk.btnTextHov : tk.btnText,
        padding: '3px 9px', borderRadius: 6,
        cursor: 'pointer', fontFamily: 'monospace', fontSize: 8,
        letterSpacing: '0.1em', textTransform: 'uppercase',
        flexShrink: 0, transition: 'all 0.15s',
      }}
    >{children}</button>
  )
}

// ─── Draggable panel ──────────────────────────────────────────────────────────
const TAB_W = 44
const TAB_H = 24

function DraggablePanel({ children, initialPos, collapsed }) {
  const dragState = useRef({ dragging: false, ox: 0, oy: 0 })
  const [pos, setPos] = useState(initialPos)

  // When expanded: keep panel fully in view. When collapsed: tab can go anywhere.
  const clamp = useCallback((x, y) => {
    if (collapsed) {
      return {
        x: Math.max(0, Math.min(window.innerWidth - TAB_W, x)),
        y: Math.max(TAB_H, Math.min(window.innerHeight - TAB_H, y)),
      }
    }
    return {
      x: Math.max(0, Math.min(window.innerWidth - PANEL_W, x)),
      y: Math.max(0, Math.min(window.innerHeight - PANEL_H, y)),
    }
  }, [collapsed])

  // When transitioning from collapsed→expanded, nudge back in bounds if needed
  useEffect(() => {
    setPos(p => clamp(p.x, p.y))
  }, [collapsed, clamp])

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

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [lines, setLines] = useState([[]])
  const [alefMetrics, setAlefMetrics] = useState(null)
  const [params, setParams] = useState(DEFAULT_PARAMS)
  const [, forceUpdate] = useState(0)
  const [panelReady, setPanelReady] = useState(false)
  const [initPos, setInitPos] = useState({ x: 0, y: 0 })
  const [theme, setTheme] = useState('dark')
  const [collapsed, setCollapsed] = useState(false)
  const [textAlign, setTextAlign] = useState('center')
  const [hasTyped, setHasTyped] = useState(false)
  const isPortrait = useIsPortrait()
  const zoom = isPortrait ? ZOOM_MOBILE : ZOOM_DESKTOP
  const glCanvasRef = useRef(null)
  const mobileInputRef = useRef(null)

  const isDark = theme === 'dark'
  const tk = useThemeTokens(isDark)

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
        setHasTyped(true)
        setLines(prev => {
          const n = prev.map(l => [...l])
          // Strip trailing space from current line before breaking
          const last = n[n.length - 1]
          if (last.length > 0 && last[last.length - 1] === 'space') {
            n[n.length - 1] = last.slice(0, -1)
          }
          return [...n, []]
        })
      } else if (keyMap[e.key]) {
        setHasTyped(true)
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

  const handleMobileInput = useCallback((e) => {
    const keyMap = {
      'א': '1','ב': '2','ג': '3','ד': '4','ה': '5','ו': '6','ז': '7','ח': '8','ט': '9','י': '10',
      'כ': '20','ך': '21','ל': '30','מ': '40','ם': '41','נ': '50','ן': '51','ס': '60','ע': '70',
      'פ': '80','ף': '81','צ': '90','ץ': '91','ק': '100','ר': '200','ש': '300','ת': '400'
    }
    const val = e.target.value
    if (!val) return
    const last = val[val.length - 1]
    if (keyMap[last]) {
      setHasTyped(true)
      setLines(prev => { const n = prev.map(l => [...l]); n[n.length - 1].push(keyMap[last]); return n })
    } else if (last === ' ') {
      setLines(prev => { const n = prev.map(l => [...l]); n[n.length - 1].push('space'); return n })
    } else if (last === '\n') {
      setHasTyped(true)
      setLines(prev => {
        const n = prev.map(l => [...l])
        const line = n[n.length - 1]
        if (line.length > 0 && line[line.length - 1] === 'space') n[n.length - 1] = line.slice(0, -1)
        return [...n, []]
      })
    }
    e.target.value = ''
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

  const handlePrint = useCallback(() => {
    const glCanvas = glCanvasRef.current
    if (!glCanvas) return
    try {
      const W = glCanvas.width
      const H = glCanvas.height

      // Footer proportions
      const FS      = Math.max(11, Math.round(H * 0.013))
      const LINE_H  = Math.round(FS * 1.6)
      const ROWS    = 3
      const PAD_X   = Math.round(W * 0.03)
      const PAD_V   = Math.round(FS * 1.2)   // equal top AND bottom
      const FOOTER  = ROWS * LINE_H + PAD_V * 2

      const out = document.createElement('canvas')
      out.width  = W
      out.height = H + FOOTER
      const ctx  = out.getContext('2d')

      ctx.clearRect(0, 0, W, H + FOOTER)
      ctx.drawImage(glCanvas, 0, 0)

      // Divider
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(PAD_X, H + 0.5); ctx.lineTo(W - PAD_X, H + 0.5); ctx.stroke()

      const textColor = 'rgba(0,0,0,0.75)'
      const dimColor  = 'rgba(0,0,0,0.32)'

      // Values use the same monospace as the UI
      const valueFontSpec = `${FS}px monospace`
      ctx.font = valueFontSpec
      ctx.textBaseline = 'top'

      // Measure one representative char to build fixed-width columns
      const CW = ctx.measureText('0').width  // digit width in current font

      // Column layout — same as the reference screenshot
      // Label col: 2 chars wide,  value col: 6 chars wide, gap between groups: 2 chars
      const C_L1  = PAD_X                        // axis label  "X"
      const C_V1  = C_L1 + CW * 3               // axis value  "-42°"
      const C_L2  = C_V1 + CW * 7               // typo label  "GAP"
      const C_V2  = C_L2 + CW * 5               // typo value  "1.0"

      const rows = [
        { l1: 'X', v1: `${params.rotX}°`, l2: 'GAP',  v2: params.gap.toFixed(1) },
        { l1: 'Y', v1: `${params.rotY}°`, l2: 'LEAD', v2: params.leading.toFixed(1) },
        { l1: 'Z', v1: `${params.rotZ}°`, l2: 'SIZE', v2: Math.round(params.size * 100).toString() },
      ]

      rows.forEach(({ l1, v1, l2, v2 }, i) => {
        const y = H + PAD_V + i * LINE_H
        ctx.font = valueFontSpec
        ctx.fillStyle = dimColor;  ctx.fillText(l1, C_L1, y)
        ctx.fillStyle = textColor; ctx.fillText(v1, C_V1, y)
        ctx.fillStyle = dimColor;  ctx.fillText(l2, C_L2, y)
        ctx.fillStyle = textColor; ctx.fillText(v2, C_V2, y)
      })

      // Hebrew text — Cascadia Mono, same size, top-aligned to first row, right edge
      const hebrewStr = lines
        .map(line => line.map(t => t === 'space' ? ' ' : (MODEL_TO_CHAR[t] ?? '')).join(''))
        .join(' ')
        .trim()

      ctx.font = `${FS}px "Cascadia Mono", "Cascadia Code", ui-monospace, SFMono-Regular, monospace`
      ctx.fillStyle = textColor
      ctx.textAlign = 'right'
      ctx.fillText(hebrewStr, W - PAD_X, H + PAD_V)
      ctx.textAlign = 'left'

      const dataURL = out.toDataURL('image/png')
      const win = window.open('', '_blank')
      if (!win) return
      win.document.write(`<!DOCTYPE html><html><head><title>Snapshot</title>
        <style>*{margin:0;padding:0}html,body{background:#fff;width:100%;height:100%}
        img{display:block;width:100%;height:auto}</style></head>
        <body><img src="${dataURL}"/></body></html>`)
      win.document.close()
    } catch (e) { console.error('Snapshot failed:', e) }
  }, [glCanvasRef, params, lines])

  const bgColor = isDark ? '#000' : '#fff'
  const arrowColor = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)'

  // Shared label style
  const labelStyle = {
    color: tk.textFaint, fontFamily: 'monospace', fontSize: 9,
    letterSpacing: '0.1em', textTransform: 'uppercase', flexShrink: 0, width: 38,
  }

  // Shared value style
  const valStyle = { color: tk.text, fontFamily: 'monospace', fontSize: 11 }

  return (
    <>
      <style>{`
        html, body, #root { margin:0; padding:0; width:100%; height:100%; overflow:hidden; background:${bgColor}; }
        @supports (height: 100dvh) {
          html, body, #root { height: 100dvh; }
        }
        /* Fill notch/home-indicator area with bg color on iOS */
        body {
          background: ${bgColor};
          /* viewport-fit=cover must be set in the HTML meta tag:
             <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"> */
        }
      `}</style>

      <div style={{
        position: 'fixed', top: 0, left: 0, width: '100%',
        // Use dvh where supported so content fills Safari's full screen inc. notch area
        height: '100%',
        background: bgColor, overflow: 'hidden', transition: 'background 0.3s',
      }}>

        {/* Sphere canvas bleeds beyond safe area so grid is visible behind notch/bar */}
        <SphereCanvas isDark={isDark} />

        {/* Desktop typing hint — fades out after first character */}
        {!isPortrait && !hasTyped && (
          <div style={{
            position: 'absolute', top: 24, left: '50%', transform: 'translateX(-50%)',
            zIndex: 5, pointerEvents: 'none',
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '6px 16px', borderRadius: 20,
            background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
            border: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}`,
            backdropFilter: 'blur(10px)',
          }}>
            <span style={{
              fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.12em',
              textTransform: 'uppercase', color: arrowColor,
            }}>Type freely in Hebrew</span>
          </div>
        )}

        {/* Mobile: hidden input to trigger keyboard on tap */}
        {isPortrait && (
          <input
            ref={mobileInputRef}
            onInput={handleMobileInput}
            style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 1, height: 1, top: 0, left: 0 }}
            type="text" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck="false"
          />
        )}

        {/* Tap-to-type hint — portrait only */}
        {isPortrait && (
          <div
            onClick={() => mobileInputRef.current?.focus()}
            style={{
              position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)',
              zIndex: 5, display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 14px', borderRadius: 20,
              background: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)',
              border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`,
              backdropFilter: 'blur(10px)', cursor: 'text', pointerEvents: 'auto',
            }}
          >
            <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
              <rect x="0.5" y="0.5" width="13" height="9" rx="1.5" stroke={arrowColor} strokeWidth="1"/>
              <rect x="2" y="2.5" width="1.5" height="1.5" rx="0.4" fill={arrowColor}/>
              <rect x="4.5" y="2.5" width="1.5" height="1.5" rx="0.4" fill={arrowColor}/>
              <rect x="7" y="2.5" width="1.5" height="1.5" rx="0.4" fill={arrowColor}/>
              <rect x="9.5" y="2.5" width="1.5" height="1.5" rx="0.4" fill={arrowColor}/>
              <rect x="3" y="5.5" width="8" height="1.5" rx="0.4" fill={arrowColor}/>
            </svg>
            <span style={{ fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: arrowColor }}>
              Tap to type
            </span>
          </div>
        )}

        <Canvas
          frameloop="demand"
          dpr={[1, 1.5]}
          style={{
            position: 'absolute',
            top: -60, bottom: -60, left: 0, right: 0,
            height: 'calc(100% + 120px)',
            zIndex: 1,
          }}
          gl={{ alpha: true, preserveDrawingBuffer: true, antialias: false, powerPreference: 'low-power' }}
          onCreated={({ gl }) => { gl.setClearColor(0x000000, 0); glCanvasRef.current = gl.domElement }}
        >
          <DreiOrtho makeDefault position={[0, 0, 100]} zoom={zoom} />
          <Suspense fallback={null}>
            <Invalidator rotX={params.rotX} rotY={params.rotY} rotZ={params.rotZ} />
            {allTokenTypes.map(type => (
              <LetterWidthProbe key={type} type={type} onDone={handleWidthDone} />
            ))}
            <LetterScene
              lines={lines} alefMetrics={alefMetrics}
              rotX={params.rotX} rotY={params.rotY} rotZ={params.rotZ}
              gap={params.gap} leading={params.leading} letterScale={params.size}
              zoom={zoom} textAlign={textAlign}
            />
            <Lights />
            <Environment preset="studio" background={false} />
          </Suspense>
          <EffectComposer>
            <Bloom intensity={2.2} luminanceThreshold={0.3} luminanceSmoothing={0.85} radius={0.85} />
          </EffectComposer>
        </Canvas>

        {panelReady && (
          <DraggablePanel initialPos={initPos} collapsed={collapsed}>
            <div style={{ position: 'relative' }}>

              {/* ── Collapse tab — on the LEFT EDGE of the slab, vertically centered near top ── */}
              {/* Rotated so it reads as a side tab */}
              <div
                data-nodrag
                onClick={() => setCollapsed(c => !c)}
                style={{
                  position: 'absolute',
                  top: 12,
                  left: -22,            // sits flush against the left edge of the slab
                  width: 22,
                  height: 40,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: tk.panelBg,
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  border: `1px solid ${tk.panelBorder}`,
                  borderRight: collapsed ? `1px solid ${tk.panelBorder}` : 'none',
                  borderRadius: collapsed ? '8px' : '8px 0 0 8px',
                  cursor: 'pointer',
                  userSelect: 'none',
                  zIndex: 11,
                  transition: 'background 0.3s',
                }}
              >
                <svg
                  width="8" height="12" viewBox="0 0 8 12" fill="none"
                  style={{
                    transform: collapsed ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.25s ease',
                  }}
                >
                  {/* Chevron pointing left (←) when expanded, right (→) when collapsed */}
                  <path d="M6 2L2 6L6 10" stroke={arrowColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>

              {/* ── Panel slab — fully invisible when collapsed (no border, no bg) ── */}
              <div style={{
                width: collapsed ? 0 : PANEL_W,
                background: collapsed ? 'transparent' : tk.panelBg,
                backdropFilter: collapsed ? 'none' : 'blur(20px) saturate(140%)',
                WebkitBackdropFilter: collapsed ? 'none' : 'blur(20px) saturate(140%)',
                border: collapsed ? 'none' : `1px solid ${tk.panelBorder}`,
                borderRadius: 20,
                padding: collapsed ? 0 : '14px 16px 12px',
                // boxShadow: collapsed ? 'none' : '0 8px 40px rgba(0,0,0,0.35)',
                overflow: 'hidden',
                maxHeight: collapsed ? 0 : 600,
                transition: 'max-height 0.3s ease, padding 0.3s ease, width 0.3s ease, background 0.3s, border-color 0.3s, box-shadow 0.3s',
                position: 'relative', zIndex: 10,
                visibility: collapsed ? 'hidden' : 'visible',
              }}>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }} data-nodrag>
                  <GlassSlider value={params.rotX} min={-180} max={180} onChange={set('rotX')} tk={tk} />
                  <GlassSlider value={params.rotY} min={-180} max={180} onChange={set('rotY')} tk={tk} />
                  <GlassSlider value={params.rotZ} min={-180} max={180} onChange={set('rotZ')} tk={tk} />
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 28 }}>
                  <div style={{ flex: 1 }} data-nodrag>
                    {[['X', 'rotX'], ['Y', 'rotY'], ['Z', 'rotZ']].map(([label, key]) => (
                      <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 0 }}>
                        <span style={{ width: 12, ...valStyle, color: tk.textDim, fontSize: 10 }}>{label}</span>
                        <span style={{ ...valStyle, fontSize: 10 }}>{params[key]}°</span>
                      </div>
                    ))}
                  </div>
                  <div data-nodrag style={{ flexShrink: 0, width: 100, height: 80, position: 'relative' }}>
                    <Canvas
                      style={{
                        position: 'absolute', top: '50%', left: '50%',
                        transform: 'translate(-50%, -50%)',
                        width: 130, height: 130,
                        background: 'transparent', cursor: 'grab',
                      }}
                      gl={{ alpha: true }}
                      orthographic
                      camera={{ zoom: 55, position: [0, 0, 10], near: 0.1, far: 100 }}
                    >
                      <CubeScene rotX={params.rotX} rotY={params.rotY} rotZ={params.rotZ} onRotate={handleCubeRotate} isDark={isDark} />
                    </Canvas>
                  </div>
                </div>

                <div style={{ borderTop: `1px solid ${tk.divider}`, paddingTop: 12, marginTop: 28, display: 'flex', flexDirection: 'column', gap: 0 }} data-nodrag>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={labelStyle}>Gap</span>
                    <GlassSlider value={params.gap} min={0} max={6} step={0.05} onChange={set('gap')} tk={tk} />
                    <span style={{ ...valStyle, fontSize: 9, color: tk.textDim, flexShrink: 0, width: 20, textAlign: 'right' }}>{params.gap.toFixed(1)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={labelStyle}>Lead</span>
                    <GlassSlider value={params.leading} min={4} max={20} step={0.1} onChange={set('leading')} tk={tk} />
                    <span style={{ ...valStyle, fontSize: 9, color: tk.textDim, flexShrink: 0, width: 20, textAlign: 'right' }}>{params.leading.toFixed(1)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={labelStyle}>Size</span>
                    <GlassSlider value={params.size} min={0.5} max={1.5} step={0.01} onChange={set('size')} tk={tk} />
                  </div>

                  {/* Alignment buttons */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 10 }}>
                    <span style={labelStyle}>Align</span>
                    <div style={{ display: 'flex', gap: 4 }} data-nodrag>
                      {[
                        { id: 'left', icon: (
                          <svg width="12" height="10" viewBox="0 0 12 10" fill="none">
                            <rect x="0" y="0" width="12" height="1.5" rx="0.75" fill="currentColor"/>
                            <rect x="0" y="3" width="8" height="1.5" rx="0.75" fill="currentColor"/>
                            <rect x="0" y="6" width="10" height="1.5" rx="0.75" fill="currentColor"/>
                            <rect x="0" y="9" width="6" height="1.5" rx="0.75" fill="currentColor"/>
                          </svg>
                        )},
                        { id: 'center', icon: (
                          <svg width="12" height="10" viewBox="0 0 12 10" fill="none">
                            <rect x="0" y="0" width="12" height="1.5" rx="0.75" fill="currentColor"/>
                            <rect x="2" y="3" width="8" height="1.5" rx="0.75" fill="currentColor"/>
                            <rect x="1" y="6" width="10" height="1.5" rx="0.75" fill="currentColor"/>
                            <rect x="3" y="9" width="6" height="1.5" rx="0.75" fill="currentColor"/>
                          </svg>
                        )},
                        { id: 'right', icon: (
                          <svg width="12" height="10" viewBox="0 0 12 10" fill="none">
                            <rect x="0" y="0" width="12" height="1.5" rx="0.75" fill="currentColor"/>
                            <rect x="4" y="3" width="8" height="1.5" rx="0.75" fill="currentColor"/>
                            <rect x="2" y="6" width="10" height="1.5" rx="0.75" fill="currentColor"/>
                            <rect x="6" y="9" width="6" height="1.5" rx="0.75" fill="currentColor"/>
                          </svg>
                        )},
                        { id: 'justify', icon: (
                          <svg width="12" height="10" viewBox="0 0 12 10" fill="none">
                            <rect x="0" y="0" width="12" height="1.5" rx="0.75" fill="currentColor"/>
                            <rect x="0" y="3" width="12" height="1.5" rx="0.75" fill="currentColor"/>
                            <rect x="0" y="6" width="12" height="1.5" rx="0.75" fill="currentColor"/>
                            <rect x="0" y="9" width="7" height="1.5" rx="0.75" fill="currentColor"/>
                          </svg>
                        )},
                      ].map(({ id, icon }) => (
                        <button
                          key={id}
                          onClick={() => setTextAlign(id)}
                          style={{
                            width: 28, height: 24,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: textAlign === id ? tk.btnBgActive : tk.btnBg,
                            border: `1px solid ${tk.btnBorder}`,
                            borderRadius: 5, cursor: 'pointer',
                            color: textAlign === id ? tk.btnTextHov : tk.btnText,
                            transition: 'all 0.15s', padding: 0,
                          }}
                        >{icon}</button>
                      ))}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${tk.divider}` }} data-nodrag>
                  <PanelBtn onClick={() => { setParams(DEFAULT_PARAMS); setTextAlign('center') }} tk={tk}>Reset</PanelBtn>
                  <PanelBtn onClick={() => { setLines([[]]); setHasTyped(false) }} tk={tk}>Clear</PanelBtn>
                  <div style={{ flex: 1 }} />
                  <PanelBtn onClick={handlePrint} tk={tk}>Print</PanelBtn>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 7 }} data-nodrag>
                  <span style={{ ...labelStyle, width: 'auto', marginRight: 2 }}>Theme</span>
                  <PanelBtn onClick={() => setTheme('dark')} active={theme === 'dark'} tk={tk}>Dark</PanelBtn>
                  <PanelBtn onClick={() => setTheme('light')} active={theme === 'light'} tk={tk}>Light</PanelBtn>
                </div>

              </div>
            </div>
          </DraggablePanel>
        )}
      </div>
    </>
  )
}
