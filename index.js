// bot.js — бот для мессенджера MAX на Node.js
// Запуск: node bot.js
// NODE: 18+ (встроенный fetch)

// ============ НАСТРОЙКИ ============
const BASE_URL = 'https://platform-api.max.ru';
const TOKEN = process.env.BOT_TOKEN;   // токен MAX-бота в переменной окружения

const fs = require('fs');
const path = require('path');
const MARKER_FILE = path.join(__dirname, 'marker.json'); // маркер long polling вместо offset

// ============ APPS SCRIPT (мост к таблице) — без изменений ============
const APPS_URL = process.env.APPS_URL;
const APPS_SECRET = process.env.APPS_SECRET;

const userState = {}; // userId -> { object: '...' }

async function appsCall(params) {
  const qs = new URLSearchParams({ secret: APPS_SECRET, ...params });
  const res = await fetch(APPS_URL + '?' + qs.toString());
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'неизвестная ошибка');
  return data;
}

async function deleteRows(object, date) {
  const data = await appsCall({ action: 'deleteRows', object: object, date: date });
  return data.deleted;
}

let usersCache = { data: null, ts: 0 };
const USERS_CACHE_MS = 5 * 60 * 1000;
async function fetchUsers() {
  if (usersCache.data && Date.now() - usersCache.ts < USERS_CACHE_MS) return usersCache.data;
  const data = await appsCall({ action: 'getUsers' });
  usersCache = { data: data.items, ts: Date.now() };
  return usersCache.data;
}

let ordersCache = { data: null, ts: 0 };
const ORDERS_CACHE_MS = 5 * 60 * 1000;
async function fetchOrders() {
  if (ordersCache.data && Date.now() - ordersCache.ts < ORDERS_CACHE_MS) return ordersCache.data;
  const data = await appsCall({ action: 'getObjects' });
  ordersCache = { data: data.items, ts: Date.now() };
  return ordersCache.data;
}

// ============ ЛОГ ============
function log(text) {
  console.log(`[${new Date().toLocaleString('ru-RU')}] ${text}`);
}

// ---- Хранилище marker ----
function getMarker() {
  try {
    const v = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8')).marker;
    return (v === null || v === undefined) ? null : Number(v);
  } catch {
    return null; // без маркера MAX отдаст только последнее обновление
  }
}
function setMarker(value) {
  try { fs.writeFileSync(MARKER_FILE, JSON.stringify({ marker: value })); }
  catch (e) { log('marker не сохранён: ' + e.message); }
}

// ============ API MAX ============
// Токен передаётся в заголовке Authorization без Bearer.
async function maxApi(httpMethod, apiPath, params = {}, body = null) {
  const qs = new URLSearchParams(params);
  const q = qs.toString() ? '?' + qs.toString() : '';
  const res = await fetch(BASE_URL + apiPath + q, {
    method: httpMethod,
    headers: { 'Authorization': TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* пустой ответ */ }
  if (!res.ok || (data && data.code)) {
    throw new Error('MAX API ' + httpMethod + ' ' + apiPath + ': HTTP ' + res.status +
                    ' ' + JSON.stringify(data).substring(0, 200));
  }
  return data;
}

// клавиатура MAX: вложение типа inline_keyboard, кнопки — type callback + payload
function toKb(rows) {
  return {
    type: 'inline_keyboard',
    payload: {
      buttons: rows.map(row => row.map(b => ({
        type: 'callback',
        text: b.text,          // лимит текста кнопки — 128 символов
        payload: b.payload     // лимит payload — 1024 символа
      })))
    }
  };
}

// отправка сообщения пользователю (в диалоге — по user_id)
async function sendMessage(userId, text, keyboard) {
  const body = { text };
  if (keyboard) body.attachments = [keyboard];
  return maxApi('POST', '/messages', { user_id: userId }, body);
}

// редактирование сообщения: PUT /messages?message_id=<mid>
async function editMessage(mid, text, keyboard) {
  const body = { text };
  if (keyboard) body.attachments = [keyboard];
  return maxApi('PUT', '/messages', { message_id: mid }, body);
}

// редактирование с fallback на новое сообщение
async function editMenu(userId, mid, text, keyboard) {
  if (mid) {
    try { return await editMessage(mid, text, keyboard); }
    catch (err) { log('editMessage: ' + err.message); }
  }
  return sendMessage(userId, text, keyboard);
}

// ответ на нажатие кнопки: POST /answers?callback_id=...
// поле message в теле заменяет исходное сообщение целиком
async function answerCallback(callbackId, text, keyboard) {
  const body = { message: { text } };
  if (keyboard) body.message.attachments = [keyboard];
  return maxApi('POST', '/answers', { callback_id: callbackId }, body);
}

// ============ МЕНЮ ============
const MAIN_MENU = [
  [ { text: '🏗️ Объекты', payload: 'menu_object' } ]
];

function ordersMenu(orders) {
  const rows = orders.map(name => [{ text: name, payload: 'order:' + name }]);
  rows.push([{ text: '⬅️ Назад', payload: 'menu_back' }]);
  return toKb(rows);
}

// ============ ПРОВЕРКА ДОСТУПА ============
// В MAX API username обычных пользователей недоступен —
// на листе «Пользователи» должны быть числовые ID пользователей MAX.
async function isAllowed(user) {
  let allowed;
  try {
    allowed = await fetchUsers();
  } catch (err) {
    log('Не удалось прочитать список пользователей: ' + err.message);
    return null; // ошибка чтения — отдельный статус
  }
  const id = String(user.user_id);
  return allowed.some(v => v.trim() === id);
}

// ============ ОБРАБОТЧИКИ ============
async function handleMessage(userId, text) {
  // доступ проверяем и здесь — чтобы посторонний не вызвал даже /start
  const allowed = await isAllowed({ user_id: userId });
  if (allowed === null) {
    await sendMessage(userId, 'ID ' + userId + ' ⚠️ Не удалось проверить доступ. Попробуйте позже.');
    return;
  }
  /**
  if (!allowed) {
    log('Отказ в доступе: id ' + userId);
    await sendMessage(userId, '⛔ Нет доступа. Ваш ID для добавления в список: ' + userId);
    return;
  }
*/
  // если ждём дату — обрабатываем ввод
  if (userState[userId]) {
    const date = text.trim();
    if (!/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(date)) {
      await sendMessage(userId, 'Напишите дату в формате ДД.ММ.ГГГГ, например 22.11.2026');
      return;
    }
    try {
      const objName = userState[userId].object;
      const ack = await sendMessage(userId, '⏳ Удаляю записи ' + objName + '…');
      const ackMid = ack && ack.message && ack.message.body ? ack.message.body.mid : null;

      const deleted = await deleteRows(objName, date);
      delete userState[userId];

      const done = deleted > 0
        ? '✅ Удалено записей: ' + deleted + '\n\nОбъект: ' + objName
        : 'Записей не найдено — по этому объекту и дате строк нет.';

      if (ackMid) {
        await editMessage(ackMid, done, toKb(MAIN_MENU)).catch(() =>
          sendMessage(userId, done, toKb(MAIN_MENU)));
      } else {
        await sendMessage(userId, done, toKb(MAIN_MENU));
      }
    } catch (err) {
      delete userState[userId];
      log('Ошибка удаления: ' + err.message);
      await sendMessage(userId, '⚠️ Не удалось удалить записи. Попробуйте позже.', toKb(MAIN_MENU));
    }
    return;
  }

  if (text === '/start' || text === '/menu') {
    await sendMessage(userId, 'Нажмите кнопку:', toKb(MAIN_MENU));
  } else {
    await sendMessage(userId, 'Меню:', toKb(MAIN_MENU));
  }
}

async function handleCallback(cb) {
  const userId = cb.user ? cb.user.user_id : null;
  if (!userId) { log('Callback без пользователя, пропуск'); return; }
  const payload = cb.payload || '';
  const originalMsg = cb.message; // исходное сообщение с кнопкой; может быть null, если удалено
  const mid = originalMsg && originalMsg.body ? originalMsg.body.mid : null;

  // ---- проверка доступа ----
  const allowed = await isAllowed(cb.user || {});
  if (allowed === null) {
    await answerCallback(cb.callback_id, 'ID ' + userId + ' ⚠️ Не удалось проверить доступ. Попробуйте позже.', toKb(MAIN_MENU));
    return;
  }
  if (!allowed) {
    log('Отказ в доступе: id ' + userId);
    await answerCallback(cb.callback_id, '⛔ Нет доступа. Ваш ID: ' + userId, toKb(MAIN_MENU));
    return;
  }
  // ---- конец проверки ----

  if (payload.startsWith('order:')) {
    const objectName = payload.slice('order:'.length);
    userState[userId] = { object: objectName };
    await sendMessage(userId,
      '🏗️ Выбранный объект: ' + objectName + '\n\nВведите дату в формате ДД.ММ.ГГГГ\n(например 22.11.2026). Будут удалены все записи этого объекта на эту дату.',
      toKb([[ { text: '⬅️ Назад', payload: 'menu_back' } ]]));
    return;
  }

  switch (payload) {
    case 'menu_object':
      try {
        const orders = await fetchOrders();
        if (!orders.length) {
          await editMenu(userId, mid, '🏗️ В таблице нет объектов', toKb(MAIN_MENU));
        } else {
          await editMenu(userId, mid, '🏗️ Выберите объект:', ordersMenu(orders));
        }
      } catch (err) {
        log('Не удалось прочитать таблицу: ' + err.message);
        await editMenu(userId, mid, '⚠️ Не удалось загрузить объекты. Попробуйте позже.', toKb(MAIN_MENU));
      }
      break;

    case 'menu_back':
      delete userState[userId];
      await editMenu(userId, mid, 'Главное меню:', toKb(MAIN_MENU));
      break;

    default:
      await editMenu(userId, mid, 'Раздел в разработке', toKb(MAIN_MENU));
  }
}

// ============ ОПРОС (Long Polling) ============
// GET /updates — маркер в ответе указывает на следующее ожидаемое обновление
// пять пользователей могут нажимать кнопки одновременно — каждый ждёт свой Apps Script параллельно, а не в очереди.
async function pollUpdates() {
  const params = { timeout: '30', limit: '100' };
  const current = getMarker();
  if (current !== null) params.marker = String(current);

  const data = await maxApi('GET', '/updates', params);

  if (data.marker !== undefined && data.marker !== null) {
    setMarker(data.marker);
  }

  // не ждём завершения обработки — следующий опрос уходит сразу
  for (const upd of (data.updates || [])) {
    handleUpdate(upd).catch(err =>
      log('Ошибка обработки: ' + err.message + ' | ' + (err.stack || '').split('\n')[1]));
  }
}

async function handleUpdate(upd) {
  if (upd.update_type === 'message_created' && upd.message && upd.message.sender) {
    const text = (upd.message.body && upd.message.body.text) || '';
    log('Сообщение от ' + upd.message.sender.user_id + ': ' + text);
    await handleMessage(upd.message.sender.user_id, text);
  } else if (upd.update_type === 'message_callback' && upd.callback) {
    log('Нажата кнопка: ' + (upd.callback.payload || ''));
    await handleCallback(upd.callback);
  } else if (upd.update_type === 'bot_started' && upd.user) {
    await sendMessage(upd.user.user_id, 'Нажмите кнопку:', toKb(MAIN_MENU));
  }
}


// ============ ЗАПУСК ============
async function main() {
  if (!TOKEN) {
    log('ОШИБКА: переменная окружения BOT_TOKEN не задана — бот останавливается.');
    process.exit(1); // Bothost увидит падение и покажет это в логах
  }

  log('Бот MAX запущен (long polling, timeout 30 сек).');
  for (;;) {
    try {
      await pollUpdates(); // сам держит соединение 30 сек, пауза не нужна
    } catch (err) {
      log('Ошибка цикла: ' + err.message);
      await new Promise(r => setTimeout(r, 3000)); // пауза только при ошибке
    }
  }
}

// Прогрев Apps Script: раз в 10 минут дёргаем getUsers,
// чтобы скрипт не засыпал, а кэш пользователей был свежим
setInterval(() => {
  appsCall({ action: 'getUsers' }).catch(e => log('Прогрев: ' + e.message));
}, 10 * 60 * 1000);

main();

