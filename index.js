#!/usr/bin/env node
/**
 * Roblox Model Helper (safe)
 * - Authenticates with your own account
 * - Searches public models by keyword
 * - Optionally uploads a local .rbxm/.rbxmx model file to your own inventory
 *
 * This tool does NOT inject scripts, bypass moderation, publish spam, or automate abuse.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const readline = require('readline-sync');
const noblox = require('noblox.js');

const SETTINGS = {
  DELAY_MS: 2500,
  MAX_PER_PAGE: 30,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function authenticate() {
  const cookie = readline.question('🔑 Pega tu cookie .ROBLOSECURITY (tu propia cuenta): ', {
    hideEchoBack: true,
    mask: '*',
  }).trim();

  if (!cookie) {
    throw new Error('Cookie vacía.');
  }

  await noblox.setCookie(cookie);
  const user = await noblox.getAuthenticatedUser();
  return { user, cookie };
}

async function searchModels(keyword, limit) {
  let cursor = '';
  const found = [];

  while (found.length < limit) {
    const url = `https://apis.roblox.com/toolbox-service/v1/marketplace/10?keyword=${encodeURIComponent(
      keyword,
    )}&limit=${SETTINGS.MAX_PER_PAGE}&cursor=${encodeURIComponent(cursor)}`;

    const response = await axios.get(url, { timeout: 15_000 });
    const data = response.data || {};
    const rows = Array.isArray(data.data) ? data.data : [];

    for (const row of rows) {
      if (found.length >= limit) break;
      found.push({
        id: row.id,
        name: row.name || row?.details?.name || 'Untitled model',
        creator: row?.creatorName || row?.creator?.name || 'Unknown',
      });
    }

    cursor = data.nextPageCursor || '';
    if (!cursor || rows.length === 0) break;
    await sleep(600);
  }

  return found;
}

async function uploadLocalModel(localPath, name, description) {
  if (!fs.existsSync(localPath)) {
    throw new Error(`No existe el archivo: ${localPath}`);
  }

  const ext = path.extname(localPath).toLowerCase();
  if (!['.rbxm', '.rbxmx'].includes(ext)) {
    throw new Error('Solo se permiten archivos .rbxm o .rbxmx');
  }

  const stream = fs.createReadStream(localPath);
  const assetId = await noblox.uploadModel(stream, {
    name,
    description,
    copyLocked: false,
    allowComments: false,
  });

  return assetId;
}

async function main() {
  console.log('=============================================');
  console.log('🧰 Roblox Model Helper (uso legítimo)');
  console.log('=============================================');

  console.log('\nEste script está diseñado para uso legítimo (cuenta y archivos propios).');

  const { user } = await authenticate();
  console.log(`✅ Sesión iniciada como ${user.name} (${user.id})`);

  const keyword = readline.question('\n🔍 Buscar modelos por palabra clave: ').trim();
  const limit = readline.questionInt('📊 ¿Cuántos resultados mostrar? ', { defaultInput: '10' });

  const results = await searchModels(keyword, Math.max(1, limit));

  if (results.length === 0) {
    console.log('⚠️ No se encontraron resultados.');
  } else {
    console.log('\nResultados:');
    for (const [idx, model] of results.entries()) {
      console.log(`${idx + 1}. ${model.name} (ID: ${model.id}) - ${model.creator}`);
    }
  }

  const doUpload = readline.keyInYNStrict('\n⬆️ ¿Quieres subir un modelo LOCAL a tu inventario?');
  if (!doUpload) {
    console.log('Listo. Saliendo sin subir archivos.');
    return;
  }

  const localPath = readline.question('📁 Ruta del archivo (.rbxm/.rbxmx): ').trim();
  const name = readline.question('📝 Nombre del modelo: ').trim() || `Model ${Date.now()}`;
  const description = readline.question('🗒️ Descripción: ').trim() || 'Uploaded with Roblox Model Helper';

  const confirm = readline.keyInYNStrict(
    'Confirmas que el archivo es tuyo y cumple las normas de Roblox?',
  );
  if (!confirm) {
    console.log('Cancelado por usuario.');
    return;
  }

  await sleep(SETTINGS.DELAY_MS);
  const assetId = await uploadLocalModel(localPath, name, description);
  console.log(`✅ Subido correctamente: https://www.roblox.com/library/${assetId}`);
}

main().catch((err) => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
