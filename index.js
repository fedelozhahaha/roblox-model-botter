#!/usr/bin/env node
/**
 * Roblox Free Model Auditor (anti-backdoor)
 *
 * Flujo seguro:
 * 1) Busca modelos públicos por keyword.
 * 2) Descarga cada modelo para auditoría estática.
 * 3) Compara scripts contra firmas locales de /infections/*.rbxm|*.rbxmx
 * 4) Exporta un reporte con riesgo por modelo.
 *
 * Este script NO inyecta código, NO altera modelos de terceros y NO automatiza spam.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const readline = require('readline-sync');
const noblox = require('noblox.js');
const { RobloxFile } = require('rbxm-parser');

const SETTINGS = {
  MAX_PER_PAGE: 30,
  REQUEST_TIMEOUT_MS: 20_000,
  BETWEEN_REQUEST_MS: 700,
  INFECTIONS_DIR: path.join(process.cwd(), 'infections'),
  REPORTS_DIR: path.join(process.cwd(), 'reports'),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function scoreTextRisk(source) {
  const normalized = String(source || '').toLowerCase();
  const heuristics = [
    { pattern: /loadstring\s*\(/, score: 30, reason: 'Usa loadstring()' },
    { pattern: /require\s*\(\s*\d{5,}\s*\)/, score: 25, reason: 'Usa require(assetId)' },
    { pattern: /getfenv|setfenv|debug\./, score: 20, reason: 'Manipulación de entorno/debug' },
    { pattern: /httpservice|syn\.request|request\s*\(/, score: 20, reason: 'Llamadas HTTP/scripting externo' },
    { pattern: /fireserver|invoke(server|client)/, score: 10, reason: 'Interacciones remotas potencialmente sensibles' },
    { pattern: /while\s+true\s+do/, score: 8, reason: 'Loop infinito' },
  ];

  let score = 0;
  const reasons = [];
  for (const h of heuristics) {
    if (h.pattern.test(normalized)) {
      score += h.score;
      reasons.push(h.reason);
    }
  }

  return { score: Math.min(score, 100), reasons };
}

function hashSnippet(input) {
  const text = String(input || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return '';
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

function collectScriptSources(node, list = []) {
  if (!node) return list;

  const isScript = node.ClassName === 'Script' || node.ClassName === 'LocalScript' || node.ClassName === 'ModuleScript';
  if (isScript && typeof node.Source === 'string') {
    list.push(node.Source);
  }

  const children = node.GetChildren ? node.GetChildren() : node.children || [];
  for (const child of children) collectScriptSources(child, list);
  return list;
}

function readModelScriptsFromBuffer(buffer) {
  const parsed = RobloxFile.ReadFromBuffer(buffer);
  return collectScriptSources(parsed);
}

function loadKnownBadSignatures() {
  ensureDir(SETTINGS.INFECTIONS_DIR);
  const files = fs
    .readdirSync(SETTINGS.INFECTIONS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.rbxm') || f.toLowerCase().endsWith('.rbxmx'));

  const signatures = new Set();
  for (const file of files) {
    const full = path.join(SETTINGS.INFECTIONS_DIR, file);
    try {
      const raw = fs.readFileSync(full);
      const scriptSources = readModelScriptsFromBuffer(raw);
      for (const src of scriptSources) {
        const sig = hashSnippet(src);
        if (sig) signatures.add(sig);
      }
    } catch (_) {
      // Si un archivo está corrupto, simplemente se ignora.
    }
  }

  return { filesCount: files.length, signatures };
}

async function authenticate() {
  const cookie = readline
    .question('🔑 Pega tu cookie .ROBLOSECURITY (solo tu cuenta): ', { hideEchoBack: true, mask: '*' })
    .trim();
  if (!cookie) throw new Error('Cookie vacía.');

  await noblox.setCookie(cookie);
  const user = await noblox.getAuthenticatedUser();
  return user;
}

async function searchModels(keyword, limit) {
  let cursor = '';
  const items = [];

  while (items.length < limit) {
    const url = `https://apis.roblox.com/toolbox-service/v1/marketplace/10?keyword=${encodeURIComponent(
      keyword,
    )}&limit=${SETTINGS.MAX_PER_PAGE}&cursor=${encodeURIComponent(cursor)}`;

    const response = await axios.get(url, { timeout: SETTINGS.REQUEST_TIMEOUT_MS });
    const rows = Array.isArray(response.data?.data) ? response.data.data : [];

    for (const row of rows) {
      if (items.length >= limit) break;
      items.push({
        id: row.id,
        name: row.name || row?.details?.name || 'Untitled model',
        creator: row?.creatorName || row?.creator?.name || 'Unknown',
      });
    }

    cursor = response.data?.nextPageCursor || '';
    if (!cursor || rows.length === 0) break;
    await sleep(SETTINGS.BETWEEN_REQUEST_MS);
  }

  return items;
}

async function downloadModelBuffer(assetId) {
  const url = `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`;
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: SETTINGS.REQUEST_TIMEOUT_MS });
  return Buffer.from(res.data);
}

function classify(score) {
  if (score >= 50) return 'HIGH';
  if (score >= 20) return 'MEDIUM';
  return 'LOW';
}

function analyzeSources(sources, knownBadSet) {
  let totalScore = 0;
  const reasons = new Set();
  let knownBadMatches = 0;

  for (const src of sources) {
    const local = scoreTextRisk(src);
    totalScore += local.score;
    local.reasons.forEach((r) => reasons.add(r));

    const sig = hashSnippet(src);
    if (sig && knownBadSet.has(sig)) {
      knownBadMatches += 1;
      totalScore += 40;
      reasons.add('Coincide con firma conocida en /infections');
    }
  }

  const normalizedScore = Math.min(100, Math.round(totalScore / Math.max(1, sources.length)));
  return {
    scriptCount: sources.length,
    knownBadMatches,
    score: normalizedScore,
    risk: classify(normalizedScore),
    reasons: Array.from(reasons),
  };
}

function saveReport(keyword, entries) {
  ensureDir(SETTINGS.REPORTS_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(SETTINGS.REPORTS_DIR, `audit-${keyword || 'query'}-${ts}.json`);
  fs.writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2));
  return output;
}

async function main() {
  console.log('=============================================');
  console.log('🛡️ Roblox Free Model Auditor (Anti-Backdoor)');
  console.log('=============================================');

  console.log('\nEste flujo audita modelos; no modifica assets de terceros ni publica spam.');
  const user = await authenticate();
  console.log(`✅ Sesión iniciada como ${user.name} (${user.id})`);

  const { filesCount, signatures } = loadKnownBadSignatures();
  console.log(`📚 Firmas cargadas desde /infections: archivos=${filesCount}, firmas=${signatures.size}`);

  const keyword = readline.question('\n🔍 Keyword a auditar: ').trim();
  const limit = Math.max(1, readline.questionInt('📊 Cuántos modelos auditar: ', { defaultInput: '10' }));

  const models = await searchModels(keyword, limit);
  if (models.length === 0) {
    console.log('⚠️ No se encontraron modelos con ese criterio.');
    return;
  }

  const report = [];
  for (const [idx, model] of models.entries()) {
    process.stdout.write(`\n[${idx + 1}/${models.length}] Auditando ${model.name} (ID ${model.id})... `);
    try {
      const buffer = await downloadModelBuffer(model.id);
      const sources = readModelScriptsFromBuffer(buffer);
      const analysis = analyzeSources(sources, signatures);
      report.push({ ...model, ...analysis });
      console.log(`${analysis.risk} (score=${analysis.score}, scripts=${analysis.scriptCount})`);
    } catch (err) {
      report.push({ ...model, error: err.message, risk: 'UNKNOWN', score: null, scriptCount: 0, reasons: [] });
      console.log('ERROR');
    }
    await sleep(SETTINGS.BETWEEN_REQUEST_MS);
  }

  const reportPath = saveReport(keyword.replace(/\s+/g, '-').toLowerCase(), report);
  console.log(`\n✅ Reporte guardado en: ${reportPath}`);

  const risky = report.filter((r) => r.risk === 'HIGH');
  console.log(`📌 Resumen: total=${report.length}, HIGH=${risky.length}, MEDIUM=${report.filter((r) => r.risk === 'MEDIUM').length}`);

  if (risky.length > 0) {
    console.log('\nModelos con riesgo HIGH:');
    for (const row of risky) {
      console.log(`- ${row.name} (ID ${row.id}) | motivos: ${row.reasons.join(', ') || 'N/A'}`);
    }
  }
}

main().catch((err) => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
