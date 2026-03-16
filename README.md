# Roblox Free Model Auditor (Anti-Backdoor)

CLI en Node.js para auditar modelos públicos y detectar riesgo de backdoors.

## Qué hace

- Busca modelos por palabra clave (Toolbox API).
- Descarga cada modelo para inspección estática.
- Analiza scripts con heurísticas de riesgo (`loadstring`, `require(id)`, etc.).
- Compara contra firmas conocidas en `./infections/*.rbxm|*.rbxmx`.
- Genera un reporte JSON en `./reports/`.

## Qué NO hace

- No inyecta scripts.
- No modifica modelos de terceros.
- No automatiza spam/publicación masiva.

## Uso

```bash
npm install
npm start
```

Durante el flujo:

1. Inicia sesión con tu `.ROBLOSECURITY` (solo tu cuenta).
2. Coloca archivos de referencia maliciosos en `./infections`.
3. Ejecuta una auditoría por keyword y revisa `./reports/*.json`.

## Seguridad

No compartas tu cookie con nadie.
