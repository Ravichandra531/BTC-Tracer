const { fetchTx, fetchAddressTxs, setProgress, TX_OUT_CAP } = require('./chain');

const ANON_CATEGORIES = new Set(['mixer', 'tumbler', 'coinjoin', 'bridge', 'anonymizer']);

function nodeTypeFor(info, fallback = 'address') {
  if (info?.category === 'exchange') return 'exchange';
  if (ANON_CATEGORIES.has(info?.category)) return 'mixer';
  return fallback;
}

function addNode(map, id, type, hop, labelInfo = null) {
  if (!map.has(id)) {
    map.set(id, {
      id, type, hop,
      label:    labelInfo?.label    ?? null,
      category: labelInfo?.category ?? null,
    });
    return;
  }
  const n = map.get(id);
  if (type === 'exchange' || type === 'mixer' || type === 'unspent') n.type = type;
  if (labelInfo?.label)    n.label    = labelInfo.label;
  if (labelInfo?.category) n.category = labelInfo.category;
}

function inputAddressSet(tx) {
  return new Set((tx.inputs || []).map(i => i.address).filter(Boolean));
}

async function forwardTrace(start, maxHops, minSats, labels, onProgress = () => {}) {
  setProgress(onProgress);
  const seed = start.trim();
  const isTxid = /^[a-fA-F0-9]{64}$/.test(seed);

  const nodeMap   = new Map();
  const edges     = [];
  const visited   = new Set();
  const queued    = new Set();
  const receivers = [];
  const warnings  = [];
  let   exchangeCount = 0;
  let   mixerCount    = 0;

  const bfsQueue = [];

  function enqueue(txid, hop, path) {
    if (queued.has(txid) || visited.has(txid)) return;
    queued.add(txid);
    bfsQueue.push({ txid, hop, path });
  }

  if (isTxid) {
    enqueue(seed, 0, [seed]);
    addNode(nodeMap, seed, 'tx', 0);
  } else {
    onProgress(`Fetching spending transactions for ${seed.slice(0, 16)}…`);
    const addrInfo = await fetchAddressTxs(seed);
    addNode(nodeMap, seed, nodeTypeFor(labels[seed]), 0, labels[seed]);

    if (addrInfo.truncated || addrInfo.spendCapHit) {
      warnings.push(
        'This address has more spending history than was fetched. ' +
        'Only the most recent outgoing transactions are followed.'
      );
    }

    if (!addrInfo.hasSpending) {
      const btcBal = (addrInfo.balance / 1e8).toFixed(8);
      warnings.push(
        `Address has no outgoing transactions — balance ${btcBal} BTC. ` +
        `All UTXOs appear unspent (or this address is unspendable).`
      );
      addNode(nodeMap, seed, 'unspent', 0, labels[seed]);
      receivers.push({
        address:  seed,
        label:    labels[seed]?.label ?? null,
        category: 'unspent-address',
        valueBTC: btcBal,
        path:     [],
        reason:   'unspent',
        hops:     0,
        isChange: false,
      });
      return { nodes: [...nodeMap.values()], edges, receivers,
               visitedCount: 0, exchangeCount: 0, mixerCount: 0, warnings };
    }

    onProgress(`Found ${addrInfo.hashes.length} spending tx(s). Starting forward trace…`);
    for (const txid of addrInfo.hashes) {
      enqueue(txid, 0, [txid]);
      addNode(nodeMap, txid, 'tx', 0);
      edges.push({ from: seed, to: txid, value: 0, label: 'spends' });
    }
  }

  while (bfsQueue.length > 0) {
    const { txid, hop, path } = bfsQueue.shift();
    if (visited.has(txid)) continue;
    if (hop > maxHops)     continue;
    visited.add(txid);

    onProgress(`Hop ${hop}/${maxHops} — tx ${txid.slice(0, 12)}…`);

    let tx;
    try {
      tx = await fetchTx(txid);
    } catch (e) {
      onProgress(`⚠ Skipping ${txid.slice(0, 12)}: ${e.message}`);
      warnings.push(`Skipped tx ${txid.slice(0, 16)}…: ${e.message}`);
      continue;
    }

    if (tx.outputs.length >= TX_OUT_CAP) {
      warnings.push(
        `Tx ${txid.slice(0, 16)}… has many outputs; only the first ${TX_OUT_CAP} were followed.`
      );
    }

    const changeSet = inputAddressSet(tx);

    for (const out of tx.outputs) {
      if (out.value < minSats) continue;
      if (!out.address)        continue;

      const addr     = out.address;
      const info     = labels[addr] ?? null;
      const btcValue = (out.value / 1e8).toFixed(8);
      const type     = nodeTypeFor(info);
      const isChange = changeSet.has(addr);

      addNode(nodeMap, addr, type, hop + 1, info);
      edges.push({
        from: txid, to: addr, value: out.value,
        label: isChange ? `${btcValue} BTC (change)` : `${btcValue} BTC`,
        isChange,
      });

      const rec = {
        address: addr,
        label: info?.label ?? null,
        category: info?.category ?? 'unknown',
        valueBTC: btcValue,
        path: [...path],
        hops: hop + 1,
        isChange,
      };

      if (info?.category === 'exchange') {
        exchangeCount++;
        receivers.push({ ...rec, reason: 'exchange' });
        continue;
      }

      if (ANON_CATEGORIES.has(info?.category)) {
        mixerCount++;
        receivers.push({ ...rec, reason: info.category });
        warnings.push(
          `Trail stopped at labelled ${info.category} ${addr.slice(0, 10)}… — ` +
          `on-chain attribution is unreliable beyond this point.`
        );
        continue;
      }

      if (!out.spentBy) {
        addNode(nodeMap, addr, 'unspent', hop + 1, info);
        receivers.push({ ...rec, reason: 'unspent' });
        continue;
      }

      const spendTxid = out.spentBy;
      addNode(nodeMap, spendTxid, 'tx', hop + 1);
      edges.push({ from: addr, to: spendTxid, value: out.value, label: 'spent', isChange });

      if (hop + 1 > maxHops) {
        receivers.push({ ...rec, reason: 'hop-limit' });
      } else {
        enqueue(spendTxid, hop + 1, [...path, spendTxid]);
      }
    }
  }

  if (exchangeCount === 0 && mixerCount === 0 && receivers.length > 0) {
    warnings.push(
      'No labelled exchange or mixer address was reached. ' +
      'End points are unspent UTXOs or hop-limit cutoffs. ' +
      'Load a labels CSV with known exchange / mixer / bridge addresses to improve coverage.'
    );
  }

  return {
    nodes: [...nodeMap.values()],
    edges,
    receivers,
    visitedCount: visited.size,
    exchangeCount,
    mixerCount,
    warnings: [...new Set(warnings)],
  };
}

function parseCSVLine(line) {
  const cols = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

function parseLabelsCSV(csv) {
  const out = {};
  if (!csv || !csv.trim()) return out;
  const lines = csv.trim().split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  const startIdx = lines[0]?.toLowerCase().includes('address') ? 1 : 0;
  for (let i = startIdx; i < lines.length; i++) {
    const [address, label, category] = parseCSVLine(lines[i]);
    if (address) out[address] = { label: label ?? '', category: (category ?? '').toLowerCase() };
  }
  return out;
}

function normalizeInput(raw) {
  let v = (raw || '').trim();
  if (/^bc1/i.test(v)) v = v.toLowerCase();
  return v;
}

function validateInput(raw) {
  const v = normalizeInput(raw);
  if (!v) return 'No input provided.';
  if (/[,\n\r]/.test(v)) return 'Input looks like CSV data (contains commas or newlines). Please enter a single Bitcoin address or txid.';
  if (/\s/.test(v))      return 'Input contains spaces. A Bitcoin address or txid has no spaces.';
  if (/^[a-fA-F0-9]{64}$/.test(v)) return null;
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{24,34}$/.test(v)) return null;
  if (/^bc1[ac-hj-np-z02-9]{6,87}$/.test(v)) return null;
  return `"${v.slice(0, 24)}${v.length > 24 ? '…' : ''}" is not a valid Bitcoin address or txid.`;
}

async function runTrace({ start, maxHops, minBTC, labelsData, onProgress }) {
  const validErr = validateInput(start);
  if (validErr) return { ok: false, error: validErr };

  const hopsN   = Math.min(5, Math.max(1, Number.isFinite(+maxHops) ? Math.floor(+maxHops) : 2));
  const minAmt  = Number.isFinite(+minBTC) && +minBTC >= 0 ? +minBTC : 0.0001;
  const minSats = Math.round(minAmt * 1e8);
  const labels  = parseLabelsCSV(labelsData ?? '');
  const seed    = normalizeInput(start);
  const send    = typeof onProgress === 'function' ? onProgress : () => {};

  send('Starting trace…');

  try {
    const work = forwardTrace(seed, hopsN, minSats, labels, send);
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Trace timed out after 45s. Try a transaction ID and max hops = 1.')), 45000)
    );
    const result = await Promise.race([work, timeout]);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  runTrace,
  forwardTrace,
  parseLabelsCSV,
  validateInput,
  normalizeInput,
};
