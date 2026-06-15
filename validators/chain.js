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
  if (config.antiDuplicadosActivo !== false) {
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
  const horaActual = new Date(Date.now() - 5 * 60 * 60 * 1000).getUTCHours().toString().padStart(2, '0');
  const enviados_esta_hora = contadorHoy?.porHora?.[horaActual] ?? 0;
  if (enviados_esta_hora >= config.limiteHorario) {
    return fail(
      `Límite horario alcanzado para hora ${horaActual} (${enviados_esta_hora}/${config.limiteHorario})`,
      'bloqueado_limite'
    );
  }

  // Envíos manuales no consumen ni revisan el límite por cliente
  const esManual = item.programadoPor?.startsWith('manual:');
  if (!esManual) {
    const enviadosCliente = contadorHoy?.porCliente?.[item.clienteId] ?? 0;
    const limiteEfectivo = Math.max(
      config.limitePorCliente ?? 1,
      Array.isArray(config.horariosDisparo) ? config.horariosDisparo.length : 1
    );
    if (enviadosCliente >= limiteEfectivo) {
      return fail(
        `Límite por cliente alcanzado para ${item.clienteId} (${enviadosCliente}/${limiteEfectivo})`,
        'bloqueado_limite'
      );
    }
  }

  return pass();
}

/**
 * Verifica si la hora actual es un horario de envío permitido.
 * Si horariosDisparo está configurado, solo envía en esas horas exactas.
 * Si no, usa la ventana horaInicio-horaFin como fallback.
 *
 * IMPORTANTE: Railway corre en UTC. Colombia = UTC-5 sin DST.
 */
export function dentroDeVentanaHoraria(config) {
  const ahoraBogota = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const horaActual = ahoraBogota.getUTCHours();
  const minutoActual = ahoraBogota.getUTCMinutes();
  const horarios = config.horariosDisparo;
  const minutos = config.minutosDisparo;

  if (Array.isArray(horarios) && horarios.length > 0) {
    return horarios.some((h, i) => {
      const m = Array.isArray(minutos) && i < minutos.length ? minutos[i] : 0;
      // Activo desde la hora:minuto configurada hasta 59 minutos después
      if (horaActual !== h) return false;
      return minutoActual >= m;
    });
  }
  return horaActual >= (config.horaInicio ?? 7) && horaActual <= (config.horaFin ?? 20);
}
