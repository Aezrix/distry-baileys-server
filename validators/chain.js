import { getDb } from '../firebase/admin.js';
import { normalizarTelefono } from '../utils/telefono.js';

/**
 * Resultado de validación.
 * ok: true → puede enviarse
 * ok: false → motivo en 'razon', tipo de log en 'tipoLog'
 */
function pass() {
  return { ok: true };
}

function fail(razon, tipoLog = 'omitido') {
  return { ok: false, razon, tipoLog };
}

/**
 * Ejecuta la cadena completa de 10 validaciones para un item de cola.
 *
 * @param {object} item - Documento de whatsapp_cola
 * @param {object} config - Configuración global (de readConfig())
 * @param {object} contadorHoy - Documento de whatsapp_contadores/{hoy}
 * @returns {{ ok: boolean, razon?: string, tipoLog?: string }}
 */
export async function validarEnvio(item, config, contadorHoy) {
  const db = getDb();

  // ── 1. Kill switch global ──────────────────────────────────────────────────
  if (!config.habilitado) {
    return fail('Kill switch activo', 'bloqueado_kill_switch');
  }

  // ── 2. Modo sandbox ────────────────────────────────────────────────────────
  // El caller maneja modoSandbox externamente, pero lo verificamos aquí también
  // para que quede registrado correctamente.
  // (No bloqueamos — el processor decide si enviar real o simular)

  // ── 3. Cliente existe en Firestore ────────────────────────────────────────
  const clienteSnap = await db.collection('clientes').doc(item.clienteId).get();
  if (!clienteSnap.exists) {
    return fail(`Cliente ${item.clienteId} no existe en Firestore`, 'omitido');
  }
  const cliente = clienteSnap.data();

  // ── 4. Teléfono existe y es válido ────────────────────────────────────────
  const telefonoActual = normalizarTelefono(cliente.telefono);
  if (!telefonoActual) {
    return fail(`Teléfono inválido o ausente: "${cliente.telefono}"`, 'omitido');
  }
  // Verificar que el teléfono no cambió desde que se creó la cola
  const telefonoCola = normalizarTelefono(item.telefono);
  if (telefonoActual !== telefonoCola) {
    return fail(
      `Teléfono cambió desde que se creó la cola: "${item.telefono}" → "${cliente.telefono}"`,
      'omitido'
    );
  }

  // ── 5. Cliente está en whitelist y habilitado ─────────────────────────────
  const whitelistSnap = await db.collection('whatsapp_whitelist').doc(item.clienteId).get();
  if (!whitelistSnap.exists || !whitelistSnap.data().habilitado) {
    return fail(`Cliente ${item.clienteId} no está en whitelist o está deshabilitado`, 'bloqueado_whitelist');
  }

  // ── 6. Crédito sigue activo ───────────────────────────────────────────────
  const creditoSnap = await db.collection('creditos').doc(item.creditoId).get();
  if (!creditoSnap.exists) {
    return fail(`Crédito ${item.creditoId} no existe`, 'omitido');
  }
  if (creditoSnap.data().estado !== 'activo') {
    return fail(`Crédito ${item.creditoId} ya no está activo (estado: ${creditoSnap.data().estado})`, 'omitido');
  }

  // ── 7. Cuota sigue sin pagar ──────────────────────────────────────────────
  const cuotaSnap = await db
    .collection('creditos').doc(item.creditoId)
    .collection('cuotas').doc(item.cuotaId)
    .get();

  if (!cuotaSnap.exists) {
    return fail(`Cuota ${item.cuotaId} no existe`, 'omitido');
  }
  if (cuotaSnap.data().pagada === true) {
    return fail(`Cuota ${item.cuotaId} ya fue pagada — omitiendo recordatorio`, 'omitido');
  }

  // ── 8. Sin envío reciente (anti-duplicados en logs) ───────────────────────
  const ventanaHoras = config.ventanaAntiDuplicados ?? 24;
  const ventanaMs = ventanaHoras * 60 * 60 * 1000;
  const desde = new Date(Date.now() - ventanaMs);

  const logDuplicado = await db.collection('whatsapp_logs')
    .where('hashId', '==', item.hashId)
    .where('tipo', 'in', ['enviado', 'simulado'])
    .where('fecha', '>=', desde)
    .limit(1)
    .get();

  if (!logDuplicado.empty) {
    return fail(
      `Ya existe envío reciente con hashId ${item.hashId} en las últimas ${ventanaHoras}h`,
      'bloqueado_duplicado'
    );
  }

  // ── 9. Límite diario ──────────────────────────────────────────────────────
  const totalDia = contadorHoy?.totalDia ?? 0;
  if (totalDia >= config.limiteDiario) {
    return fail(
      `Límite diario alcanzado (${totalDia}/${config.limiteDiario})`,
      'bloqueado_limite'
    );
  }

  // ── 10. Límite horario y por cliente ──────────────────────────────────────
  const horaActual = new Date().getHours().toString().padStart(2, '0');
  const enviados_esta_hora = contadorHoy?.porHora?.[horaActual] ?? 0;
  if (enviados_esta_hora >= config.limiteHorario) {
    return fail(
      `Límite horario alcanzado para hora ${horaActual} (${enviados_esta_hora}/${config.limiteHorario})`,
      'bloqueado_limite'
    );
  }

  const enviadosCliente = contadorHoy?.porCliente?.[item.clienteId] ?? 0;
  if (enviadosCliente >= config.limitePorCliente) {
    return fail(
      `Límite por cliente alcanzado para ${item.clienteId} (${enviadosCliente}/${config.limitePorCliente})`,
      'bloqueado_limite'
    );
  }

  return pass();
}

/**
 * Verifica si la hora actual está dentro de la ventana permitida.
 */
export function dentroDeVentanaHoraria(config) {
  const hora = new Date().getHours();
  return hora >= (config.horaInicio ?? 7) && hora <= (config.horaFin ?? 20);
}
