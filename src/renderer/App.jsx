import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as d3 from 'd3';

/* ─────────────────────────────────────────────────────────────────────────────
   App  —  Bitcoin Forward Tracer
   Single-file React app. All logic here; CSS via module.
───────────────────────────────────────────────────────────────────────────── */

const TAB = { GRAPH: 'graph', TABLE: 'table' };

const SAMPLE_CSV = `address,label,category
1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s,Binance Hot Wallet,exchange
3E35SFZkfLMGo4qX5aVs1bBDSnAuGgBTs,Coinbase Cold,exchange
bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh,Kraken Deposit,exchange
bc1q9d3xa5gg45q2d9hhlkkm8e6dplc9uzpvgcjzln,OKX Hot,exchange
3Nxwenay9Z8Lc9JBiywExpnEFiLp6Afp8v,BitFinex Cold,exchange
1FzWLkAahHooV3kzTgyx6qsswXJ6sCXkgs,Huobi Hot,exchange
3P3QsMVK89JBI7RYPQ6mFerKHsNrNmTNEq,Bitmex Hot,exchange
1A1zP1eP5QGefi2DMPTfTL5SLmv7Divfna,Genesis Block,historical
bc1qnsa4yspep3dsjm5l9q34gdjnvl4lz0wnfhq3ug,Wasabi Coinjoin,mixer
3NWPMqbMFqHqXCMNDqBkKpKFQPXM3PNRSH,Wasabi Coinjoin 2,mixer
bc1qf3em5qzdkhhsktx3re0fkk6fkl4qfpspwrxcq,JoinMarket,mixer`;

function normalizeBTCInput(raw) {
  let v = (raw || '').trim();
  if (/^bc1/i.test(v)) v = v.toLowerCase();
  return v;
}

function validateBTCInput(raw) {
  const v = normalizeBTCInput(raw);
  if (!v) return 'Please enter a Bitcoin address or transaction ID.';

  if (/[,\n\r]/.test(v))
    return 'Input contains multiple lines or commas. Please enter a single Bitcoin address or txid, not CSV data.';
  if (/\s/.test(v))
    return 'Input contains spaces. A Bitcoin address or txid has no spaces.';

  if (/^[a-fA-F0-9]{64}$/.test(v)) return null;
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{24,34}$/.test(v)) return null;
  if (/^bc1[ac-hj-np-z02-9]{6,87}$/.test(v)) return null;

  return `"${v.slice(0, 20)}${v.length > 20 ? '…' : ''}" is not a recognised Bitcoin address or txid format.`;
}

export default function App() {
  // ── Form state ──
  const [start,   setStart]   = useState('');
  const [maxHops, setMaxHops] = useState(2);
  const [minBTC,  setMinBTC]  = useState(0.0001);
  const [labelsCSV, setLabels] = useState(SAMPLE_CSV);
  const [labelsFile, setLabelsFile] = useState('built-in sample');

  // ── Result state ──
  const [status,    setStatus]  = useState('idle'); // idle | running | done | error
  const [progress,  setProgress] = useState([]);
  const [result,    setResult]  = useState(null);   // { nodes, edges, receivers, visitedCount }
  const [error,     setError]   = useState('');
  const [tab,       setTab]     = useState(TAB.GRAPH);
  const [inputErr,  setInputErr] = useState('');    // client-side validation error

  // ── Run trace ──
  const handleTrace = useCallback(async () => {
    const target = normalizeBTCInput(start);
    const validErr = validateBTCInput(target);
    if (validErr) { setInputErr(validErr); return; }
    setStart(target);
    setInputErr('');

    setStatus('running');
    setProgress([]);
    setResult(null);
    setError('');

    window.api?.offProgress();
    window.api?.onProgress(msg => setProgress(p => [...p.slice(-19), msg]));

    try {
      const res = await (window.api
        ? window.api.trace({ start: target, maxHops, minBTC, labelsData: labelsCSV })
        : httpTrace({ start: target, maxHops, minBTC, labelsData: labelsCSV })
      );

      if (res.ok) {
        setResult(res.result);
        setStatus('done');
        setTab(TAB.GRAPH);
      } else {
        setError(res.error ?? 'Unknown error');
        setStatus('error');
      }
    } catch (e) {
      setError(e?.message ?? 'Unknown error');
      setStatus('error');
    } finally {
      window.api?.offProgress();
    }
  }, [start, maxHops, minBTC, labelsCSV]);

  // ── Load CSV ──
  const handleLoadCSV = async () => {
    if (!window.api) return;
    const csv = await window.api.openCSV();
    if (csv) { setLabels(csv); setLabelsFile('loaded file'); }
  };

  // ── Export ──
  const handleExport = async () => {
    if (!result || !window.api) return;
    const payload = { start, maxHops, minBTC, exportedAt: new Date().toISOString(), ...result };
    const ok = await window.api.exportJSON(payload);
    if (ok) showToast('Exported successfully');
  };

  return (
    <div style={S.shell}>
      <TitleBar />
      <div style={S.body}>
        {/* ── Sidebar ── */}
        <aside style={S.sidebar}>
          <Logo />
          <SidebarSection title="Target">
            <label style={S.label}>Bitcoin Address or Transaction ID</label>
            <div style={{ position: 'relative' }}>
              <textarea
                style={{
                  ...S.input, ...S.mono,
                  height: 72,
                  resize: 'none',
                  border: inputErr
                    ? '1px solid rgba(239,68,68,0.7)'
                    : '1px solid var(--border2)',
                  paddingRight: start ? 28 : 9,
                  lineHeight: 1.5,
                }}
                value={start}
                onChange={e => { setStart(e.target.value); setInputErr(''); }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTrace(); } }}
                placeholder={'e.g. 1A1zP1eP5QGe… or\nabc123…64hex'}
                spellCheck={false}
                autoComplete="off"
              />
              {start && (
                <button
                  onClick={() => { setStart(''); setInputErr(''); }}
                  title="Clear"
                  style={{
                    position: 'absolute', top: 6, right: 6,
                    background: 'rgba(255,255,255,0.07)', border: 'none',
                    color: 'var(--muted)', borderRadius: 4, width: 18, height: 18,
                    fontSize: 10, cursor: 'pointer', lineHeight: '18px', textAlign: 'center',
                  }}
                >✕</button>
              )}
            </div>
            {inputErr && (
              <div style={{
                fontSize: 11, color: 'var(--red)', marginTop: 5,
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: 6, padding: '6px 9px', lineHeight: 1.5,
              }}>
                ⚠ {inputErr}
              </div>
            )}
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
              Accepts: Legacy (1…), P2SH (3…), Bech32 (bc1…), or 64-char txid
            </div>
          </SidebarSection>

          <SidebarSection title="Parameters">
            <label style={S.label}>Max Hops <Hint text="Max 5 (API rate limit)" /></label>
            <input type="number" style={S.input} value={maxHops} min={1} max={5}
              onChange={e => setMaxHops(Math.min(5, Math.max(1, +e.target.value || 1)))} />

            <label style={{ ...S.label, marginTop: 10 }}>Min Amount (BTC)</label>
            <input type="number" style={S.input} value={minBTC} min={0} step={0.0001}
              onChange={e => {
                const n = +e.target.value;
                setMinBTC(Number.isFinite(n) && n >= 0 ? n : 0);
              }} />
          </SidebarSection>

          <SidebarSection title="Labels CSV">
            <div style={S.csvRow}>
              <span style={{ ...S.mono, fontSize: 10, color: 'var(--sub)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {labelsFile}
              </span>
              <button style={S.tinyBtn} onClick={handleLoadCSV}>Load…</button>
            </div>
            <textarea
              style={{ ...S.input, ...S.mono, height: 110, resize: 'vertical', fontSize: 10, marginTop: 6 }}
              value={labelsCSV}
              onChange={e => setLabels(e.target.value)}
              placeholder="address,label,category"
              spellCheck={false}
            />
            <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
              <code style={{ color: 'var(--amber)' }}>exchange</code> stops as cash-out;
              <code style={{ color: 'var(--red)', marginLeft: 4 }}>mixer</code>/<code style={{ color: 'var(--red)' }}>bridge</code> stops as anonymizers.
            </div>
          </SidebarSection>

          <button
            style={{ ...S.traceBtn, opacity: (status === 'running' || !start.trim()) ? 0.55 : 1 }}
            disabled={status === 'running' || !start.trim()}
            onClick={handleTrace}
          >
            {status === 'running' ? '⏳ Tracing…' : '▶ Trace Forward'}
          </button>

          {result && (
            <button style={S.exportBtn} onClick={handleExport}>⬇ Export JSON</button>
          )}

          {/* Progress log */}
          {(status === 'running' || progress.length > 0) && (
            <div style={S.progressBox}>
              {progress.map((m, i) => (
                <div key={i} style={{ color: i === progress.length - 1 ? 'var(--amber)' : 'var(--sub)', fontSize: 10, lineHeight: 1.6 }}>{m}</div>
              ))}
              {status === 'running' && <div style={{ color: 'var(--amber)', animation: 'blink 1s step-end infinite' }}>●</div>}
            </div>
          )}
        </aside>

        {/* ── Main panel ── */}
        <main style={S.main}>
          {status === 'idle' && <EmptyState />}
          {status === 'running' && <RunningState progress={progress} />}
          {status === 'error' && <ErrorState msg={error} onReset={() => setStatus('idle')} />}
          {status === 'done' && result && (
            <ResultPanel
              result={result}
              tab={tab}
              setTab={setTab}
              start={normalizeBTCInput(start)}
            />
          )}
        </main>
      </div>
    </div>
  );
}

/* ─── Title Bar ─────────────────────────────────────────────────────────────── */
function TitleBar() {
  return (
    <div style={S.titlebar}>
      <div style={{ WebkitAppRegion: 'drag', display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12 }}>
        <span style={{ fontSize: 16 }}>₿</span>
        <span style={{ fontWeight: 700, fontSize: 13 }}>Bitcoin Forward Tracer</span>
        <span style={{ background: '#ef4444', color: '#fff', fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 4, letterSpacing: '0.06em' }}>NCB</span>
      </div>
      <div style={{ WebkitAppRegion: 'no-drag', display: 'flex', gap: 4 }}>
        {[['─', () => window.api?.minimize()],['□', () => window.api?.maximize()],['✕', () => window.api?.close()]].map(([sym, fn], i) => (
          <button key={i} style={S.winBtn} className={sym === '✕' ? 'close' : ''} onClick={fn}>{sym}</button>
        ))}
      </div>
    </div>
  );
}

/* ─── Result Panel ──────────────────────────────────────────────────────────── */
function ResultPanel({ result, tab, setTab, start }) {
  const { nodes, edges, receivers, visitedCount, warnings = [], exchangeCount = 0, mixerCount = 0 } = result;

  const stats = [
    { label: 'TXs Visited',    value: visitedCount },
    { label: 'Graph Nodes',    value: nodes.length },
    { label: 'End Receivers',  value: receivers.length },
    { label: 'Exchanges Hit',  value: exchangeCount },
    { label: 'Mixers / Bridges', value: mixerCount },
    { label: 'Unspent UTXOs', value: receivers.filter(r => r.reason === 'unspent').length },
    { label: 'Hop-limit Cuts', value: receivers.filter(r => r.reason === 'hop-limit').length },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Stats bar */}
      <div style={S.statsBar}>
        {stats.map(({ label, value }) => (
          <div key={label} style={S.statChip}>
            <span style={{ fontSize: 20, fontWeight: 800 }}>{value}</span>
            <span style={{ fontSize: 10, color: 'var(--sub)', marginTop: 1 }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Warnings banner — shown when there are warnings (e.g. no exchange reached) */}
      {warnings.length > 0 && (
        <div style={{
          flexShrink: 0,
          background: 'rgba(245,158,11,0.07)',
          borderBottom: '1px solid rgba(245,158,11,0.18)',
          padding: '7px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
        }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 11, color: 'var(--amber)', lineHeight: 1.55 }}>
              <span style={{ marginRight: 6, opacity: 0.7 }}>⚠</span>{w}
            </div>
          ))}
        </div>
      )}

      {/* Tab bar */}
      <div style={S.tabBar}>
        <TabBtn active={tab === TAB.GRAPH} onClick={() => setTab(TAB.GRAPH)}>📊 Graph</TabBtn>
        <TabBtn active={tab === TAB.TABLE} onClick={() => setTab(TAB.TABLE)}>📋 End Receivers ({receivers.length})</TabBtn>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {tab === TAB.GRAPH && <GraphView nodes={nodes} edges={edges} start={start} />}
        {tab === TAB.TABLE && <ReceiversTable receivers={receivers} />}
      </div>
    </div>
  );
}


/* ─── D3 Graph ──────────────────────────────────────────────────────────────── */
function GraphView({ nodes, edges, start }) {
  const svgRef = useRef(null);
  const simRef = useRef(null);

  useEffect(() => {
    if (!svgRef.current || !nodes.length) return;
    drawGraph(svgRef.current, nodes, edges, start, simRef);
    return () => simRef.current?.stop();
  }, [nodes, edges, start]);

  const legend = [
    { color: 'var(--tx)',   label: 'Transaction' },
    { color: 'var(--addr)', label: 'Address' },
    { color: 'var(--exch)', label: 'Exchange (stop)' },
    { color: 'var(--red)',  label: 'Mixer / bridge (stop)' },
    { color: 'var(--unsp)', label: 'Unspent UTXO' },
  ];

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: 'var(--bg)' }}>
      <svg ref={svgRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {/* Legend */}
      <div style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(12,18,32,0.88)', border: '1px solid var(--border2)', borderRadius: 8, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {legend.map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, boxShadow: `0 0 5px ${color}` }} />
            <span style={{ color: 'var(--sub)' }}>{label}</span>
          </div>
        ))}
      </div>
      {/* Hint */}
      <div style={{ position: 'absolute', bottom: 10, right: 14, fontSize: 10, color: 'var(--muted)' }}>
        Drag nodes • Scroll to zoom
      </div>
    </div>
  );
}

function drawGraph(svgEl, nodes, edges, startId, simRef) {
  const w = svgEl.clientWidth  || 900;
  const h = svgEl.clientHeight || 540;

  d3.select(svgEl).selectAll('*').remove();
  const svg = d3.select(svgEl);

  // Defs: arrowhead + glow
  const defs = svg.append('defs');
  defs.append('marker').attr('id', 'arrow').attr('viewBox', '0 -4 8 8')
    .attr('refX', 26).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', 'rgba(255,255,255,0.15)');

  const filt = defs.append('filter').attr('id', 'glow');
  filt.append('feGaussianBlur').attr('stdDeviation', 3.5).attr('result', 'blur');
  const fm = filt.append('feMerge');
  fm.append('feMergeNode').attr('in', 'blur');
  fm.append('feMergeNode').attr('in', 'SourceGraphic');

  const g = svg.append('g');

  // Zoom
  svg.call(d3.zoom().scaleExtent([0.1, 8])
    .on('zoom', e => g.attr('transform', e.transform)));

  // Node colour
  const colour = d => {
    if (d.type === 'tx')       return 'var(--tx)';
    if (d.type === 'exchange') return 'var(--exch)';
    if (d.type === 'mixer')    return 'var(--red)';
    if (d.type === 'unspent')  return 'var(--unsp)';
    return 'var(--addr)';
  };

  const r = d => {
    if (d.id === startId) return 20;
    if (d.type === 'tx')  return 12;
    if (d.type === 'exchange' || d.type === 'mixer') return 16;
    return 11;
  };

  // Simulation — map edge from/to to D3's expected source/target
  const linkData = edges.map(e => ({ source: e.from, target: e.to, value: e.value, label: e.label }));
  const nodeData = nodes.map(n => ({ ...n }));

  // Filter out links whose source/target are missing from nodeData (safety)
  const nodeIds = new Set(nodeData.map(n => n.id));
  const validLinks = linkData.filter(l => nodeIds.has(l.source) && nodeIds.has(l.target));

  const sim = d3.forceSimulation(nodeData)
    .force('link', d3.forceLink(validLinks).id(d => d.id).distance(100).strength(0.6))
    .force('charge', d3.forceManyBody().strength(-350))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collision', d3.forceCollide().radius(d => r(d) + 8));

  simRef.current = sim;

  const link = g.append('g').selectAll('line').data(validLinks).join('line')
    .attr('stroke', 'rgba(255,255,255,0.1)')
    .attr('stroke-width', 1.2)
    .attr('marker-end', 'url(#arrow)');

  const linkLabel = g.append('g').selectAll('text').data(validLinks).join('text')
    .attr('fill', 'rgba(139,153,187,0.65)')
    .attr('font-size', 8)
    .attr('font-family', "'JetBrains Mono', monospace")
    .attr('text-anchor', 'middle')
    .text(d => d.label ?? '');

  const node = g.append('g').selectAll('g').data(nodeData).join('g')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  // Circle
  node.append('circle')
    .attr('r', r)
    .attr('fill', d => {
      if (d.type === 'tx')       return '#1e3a5f';
      if (d.type === 'exchange') return '#3d2800';
      if (d.type === 'mixer')    return '#3a1010';
      if (d.type === 'unspent')  return '#24143a';
      return '#0e3320';
    })
    .attr('stroke', colour)
    .attr('stroke-width', d => d.id === startId ? 3 : 1.8)
    .attr('filter', d => ['exchange', 'mixer', 'unspent'].includes(d.type) || d.id === startId ? 'url(#glow)' : null);

  // Label icon
  node.append('text')
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .attr('font-size', d => r(d) * 0.8)
    .attr('fill', colour)
    .text(d => {
      if (d.id === startId) return '★';
      if (d.type === 'tx')       return '⬡';
      if (d.type === 'exchange') return '⇄';
      if (d.type === 'mixer')    return '⊘';
      if (d.type === 'unspent')  return '◆';
      return '⬤';
    });

  // Tooltip text
  node.append('title').text(d =>
    `${d.id}\nType: ${d.type}${d.label ? `\nLabel: ${d.label}` : ''}${d.category ? `\nCategory: ${d.category}` : ''}`
  );

  // Address label below node
  node.append('text')
    .attr('dy', d => r(d) + 11)
    .attr('text-anchor', 'middle')
    .attr('fill', 'rgba(139,153,187,0.7)')
    .attr('font-size', 8)
    .attr('font-family', "'JetBrains Mono', monospace")
    .text(d => {
      const id = d.label ?? d.id;
      return id.length > 16 ? `${id.slice(0,8)}…${id.slice(-4)}` : id;
    });

  sim.on('tick', () => {
    link
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    linkLabel
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
}

/* ─── Receivers Table ───────────────────────────────────────────────────────── */
function ReceiversTable({ receivers }) {
  if (!receivers.length) {
    return <div style={{ padding: 32, color: 'var(--muted)', textAlign: 'center' }}>No end receivers found at this hop depth / min-amount threshold.</div>;
  }

  const cols = ['Address', 'Label', 'Category', 'BTC', 'Role', 'Hops', 'Reason', 'Tx Path'];

  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      <table style={S.table}>
        <thead>
          <tr>
            {cols.map(c => <th key={c} style={S.th}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {receivers.map((r, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.018)' }}>
              <td style={{ ...S.td, ...S.mono, fontSize: 10, color: 'var(--mono)' }}>
                <CopyCell text={r.address} display={shortId(r.address)} />
              </td>
              <td style={{ ...S.td, color: r.label ? 'var(--amber)' : 'var(--muted)' }}>{r.label ?? '—'}</td>
              <td style={S.td}><CategoryBadge cat={r.category} /></td>
              <td style={{ ...S.td, ...S.mono, fontWeight: 700 }}>{r.valueBTC}</td>
              <td style={S.td}>{r.isChange
                ? <span style={{ fontSize: 10, color: 'var(--muted)' }}>change</span>
                : <span style={{ fontSize: 10, color: 'var(--green)' }}>payment</span>}</td>
              <td style={{ ...S.td, textAlign: 'center' }}>{r.hops}</td>
              <td style={S.td}><ReasonBadge reason={r.reason} /></td>
              <td style={{ ...S.td, maxWidth: 260 }}>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(r.path || []).map((txid, j) => (
                    <CopyCell key={j} text={txid} display={shortId(txid, 8, 0)} style={{ fontSize: 9, color: 'var(--sub)' }} />
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Small components ──────────────────────────────────────────────────────── */
function Logo() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 6px' }}>
      <span style={{ fontSize: 22, filter: 'drop-shadow(0 0 6px #f59e0b)' }}>₿</span>
      <div>
        <div style={{ fontWeight: 800, fontSize: 13, lineHeight: 1 }}>Forward Tracer</div>
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>Bitcoin Fund Trail</div>
      </div>
    </div>
  );
}

function SidebarSection({ title, children }) {
  return (
    <div style={S.section}>
      <div style={S.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      ...S.tabBtn,
      background: active ? 'rgba(245,158,11,0.12)' : 'transparent',
      color: active ? 'var(--amber)' : 'var(--sub)',
      borderBottom: active ? '2px solid var(--amber)' : '2px solid transparent',
    }}>{children}</button>
  );
}

function Hint({ text }) {
  return <span title={text} style={{ color: 'var(--muted)', fontSize: 10, cursor: 'help' }}>ⓘ</span>;
}

function CopyCell({ text, display, style: extra }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  return (
    <span onClick={copy} title={`Click to copy: ${text}`}
      style={{ cursor: 'pointer', color: copied ? 'var(--green)' : 'inherit', ...extra }}>
      {copied ? '✓ copied' : display ?? text}
    </span>
  );
}

function CategoryBadge({ cat }) {
  const colours = {
    exchange:         '#f59e0b',
    mixer:            '#ef4444',
    tumbler:          '#ef4444',
    coinjoin:         '#ef4444',
    bridge:           '#ef4444',
    anonymizer:       '#ef4444',
    unknown:          '#4a5878',
    service:          '#3b82f6',
    historical:       '#8b5cf6',
    'unspent-address':'#a855f7',
  };
  const c = colours[cat] ?? colours.unknown;
  const display = cat === 'unspent-address' ? 'unspent' : cat;
  return cat && cat !== 'unknown'
    ? <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 999, background: `${c}22`, color: c, border: `1px solid ${c}44` }}>{display}</span>
    : <span style={{ color: 'var(--muted)', fontSize: 10 }}>—</span>;
}

function shortId(id, head = 10, tail = 4) {
  if (!id) return '—';
  if (id.length <= head + tail + 1) return id;
  return tail ? `${id.slice(0, head)}…${id.slice(-tail)}` : `${id.slice(0, head)}…`;
}

function ReasonBadge({ reason }) {
  if (reason === 'exchange')
    return <span style={{ fontSize: 10, color: 'var(--amber)',  fontWeight: 700 }}>⇄ exchange</span>;
  if (reason === 'hop-limit')
    return <span style={{ fontSize: 10, color: 'var(--blue)',   fontWeight: 700 }}>⧹ hop limit</span>;
  if (['mixer', 'tumbler', 'coinjoin', 'bridge', 'anonymizer'].includes(reason))
    return <span style={{ fontSize: 10, color: 'var(--red)', fontWeight: 700 }}>⊘ {reason}</span>;
  return       <span style={{ fontSize: 10, color: 'var(--purple)', fontWeight: 700 }}>◆ unspent</span>;
}

function EmptyState() {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--muted)' }}>
      <span style={{ fontSize: 64, filter: 'drop-shadow(0 0 24px rgba(245,158,11,0.3))' }}>₿</span>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--sub)', marginBottom: 6 }}>Enter a Bitcoin address or transaction ID</div>
        <div style={{ fontSize: 13, maxWidth: 380, lineHeight: 1.7 }}>
          Follows Bitcoin outputs hop-by-hop and stops at a labelled <span style={{ color: 'var(--amber)' }}>exchange</span>, <span style={{ color: 'var(--red)' }}>mixer/bridge</span>, or an <span style={{ color: 'var(--purple)' }}>unspent UTXO</span>. This traces on-chain BTC only — not Monero or off-chain USDT.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        {[['₿ Address', 'green'],['⬡ Transaction', 'blue'],['⇄ Exchange stop', 'amber'],['◆ Unspent UTXO', 'purple']].map(([l, c]) => (
          <div key={l} style={{ fontSize: 11, padding: '4px 12px', borderRadius: 999, background: `var(--${c}-dim,rgba(255,255,255,0.05))`, color: `var(--${c})` }}>{l}</div>
        ))}
      </div>
    </div>
  );
}

function RunningState({ progress }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
      <div style={{ width: 50, height: 50, border: '3px solid rgba(245,158,11,0.15)', borderTop: '3px solid var(--amber)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontWeight: 700, color: 'var(--amber)', marginBottom: 6 }}>Tracing funds…</div>
        {progress.slice(-1).map((p, i) => (
          <div key={i} style={{ fontSize: 12, color: 'var(--sub)', fontFamily: 'var(--mono-font)' }}>{p}</div>
        ))}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ErrorState({ msg, onReset }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <span style={{ fontSize: 48 }}>⚠</span>
      <div style={{ color: 'var(--red)', fontWeight: 700, fontSize: 15 }}>Trace Failed</div>
      <div style={{ color: 'var(--sub)', fontSize: 13, maxWidth: 420, textAlign: 'center', fontFamily: 'var(--mono-font)' }}>{msg}</div>
      <button style={S.traceBtn} onClick={onReset}>Try Again</button>
    </div>
  );
}

/* ─── Toast helper ─────────────────────────────────────────────────────────── */
function showToast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', bottom: 20, right: 20, background: '#1a2740',
    border: '1px solid var(--border2)', borderLeft: '3px solid var(--green)',
    color: '#e2eaff', padding: '10px 16px', borderRadius: 8,
    fontSize: 13, fontFamily: 'Inter, sans-serif', zIndex: 9999,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    animation: 'fadeIn 0.25s ease',
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

async function httpTrace(payload) {
  const res = await fetch('/api/trace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Trace endpoint failed (HTTP ${res.status})`);
  return data;
}

/* ─── Styles object ─────────────────────────────────────────────────────────── */
const S = {
  shell:    { display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--bg)' },
  titlebar: { height: 38, background: 'var(--surface)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 6, flexShrink: 0, WebkitAppRegion: 'drag' },
  winBtn:   { width: 30, height: 26, background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', borderRadius: 5, fontSize: 12, WebkitAppRegion: 'no-drag', transition: 'background 0.15s, color 0.15s' },
  body:     { display: 'flex', flex: 1, overflow: 'hidden' },
  sidebar:  { width: 270, background: 'var(--surface)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden auto', flexShrink: 0, padding: '0 0 12px' },
  main:     { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },

  section:      { padding: '10px 14px 0', display: 'flex', flexDirection: 'column', gap: 4 },
  sectionTitle: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)', marginBottom: 4, paddingBottom: 4, borderBottom: '1px solid var(--border)' },

  label: { fontSize: 11, fontWeight: 500, color: 'var(--sub)' },
  input: { width: '100%', background: 'var(--card)', border: '1px solid var(--border2)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '7px 9px', outline: 'none' },
  mono:  { fontFamily: "'JetBrains Mono', monospace" },

  csvRow:   { display: 'flex', alignItems: 'center', gap: 6 },
  tinyBtn:  { background: 'var(--card)', border: '1px solid var(--border2)', color: 'var(--sub)', fontSize: 10, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap' },

  traceBtn:  { margin: '14px 14px 0', padding: '10px 0', background: 'linear-gradient(135deg, #f59e0b, #f97316)', color: '#000', fontWeight: 800, fontSize: 13, border: 'none', borderRadius: 8, cursor: 'pointer', transition: 'opacity 0.2s, transform 0.2s' },
  exportBtn: { margin: '8px 14px 0', padding: '8px 0', background: 'transparent', color: 'var(--sub)', fontWeight: 600, fontSize: 12, border: '1px solid var(--border2)', borderRadius: 8, cursor: 'pointer' },

  progressBox: { margin: '10px 14px 0', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 10px', maxHeight: 120, overflow: 'auto' },

  statsBar:  { display: 'flex', gap: 1, padding: '10px 14px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  statChip:  { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '6px 0' },

  tabBar:   { display: 'flex', background: 'var(--card)', borderBottom: '1px solid var(--border)', flexShrink: 0 },
  tabBtn:   { padding: '9px 18px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, transition: 'background 0.15s, color 0.15s' },

  table:    { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th:       { padding: '8px 12px', fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', background: 'var(--card)', borderBottom: '1px solid var(--border)', textAlign: 'left', whiteSpace: 'nowrap', position: 'sticky', top: 0 },
  td:       { padding: '7px 12px', borderBottom: '1px solid var(--border)', verticalAlign: 'middle', color: 'var(--sub)' },
};
