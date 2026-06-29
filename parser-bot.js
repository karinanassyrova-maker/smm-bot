// SMM Parser Bot — читает рабочий чат и создаёт задачи автоматически
// Запуск: node parser-bot.js

const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = '8804888382:AAEr0dZLKpWf9wEGjtLeh41toy9xSRtKXtc';      // @BotFather → /newbot (второй бот)
const ANTHROPIC_KEY = 'sk-ant-ВАШ_КЛЮЧ';     // console.anthropic.com
const SUPABASE_URL = 'https://riwjxtjwcnlledvfcqpb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpd2p4dGp3Y25sbGVkdmZjcXBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1ODM1MjksImV4cCI6MjA5NjE1OTUyOX0.jY6lwTVGld6aeHay1eC30O4SLWumZDM_10FhQ1MHn7I';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Ключевые слова которые сигнализируют о задаче
const TASK_TRIGGERS = [
  'нужно', 'надо', 'сделать', 'подготовить', 'написать', 'опубликовать',
  'снять', 'запустить', 'до ', 'дедлайн', 'срочно', 'не забудь', 'не забыть',
  'задача', 'пост', 'reels', 'сторис', 'stories', 'контент'
];

// Проверяем содержит ли сообщение потенциальную задачу
function looksLikeTask(text) {
  const lower = text.toLowerCase();
  return TASK_TRIGGERS.some(trigger => lower.includes(trigger));
}

// Получаем день недели для дедлайна
function getDayDate(dayName) {
  const days = { 
    'понедельник': 1, 'пн': 1,
    'вторник': 2, 'вт': 2,
    'среда': 3, 'среду': 3, 'ср': 3,
    'четверг': 4, 'чт': 4,
    'пятница': 5, 'пятницу': 5, 'пт': 5,
    'суббота': 6, 'субботу': 6, 'сб': 6,
    'воскресенье': 0, 'вс': 0
  };
  
  const today = new Date();
  const targetDay = days[dayName.toLowerCase()];
  if (targetDay === undefined) return null;
  
  const currentDay = today.getDay();
  let diff = targetDay - currentDay;
  if (diff <= 0) diff += 7;
  
  const result = new Date(today);
  result.setDate(today.getDate() + diff);
  return result.toISOString().split('T')[0];
}

// Анализируем сообщение через Claude
async function analyzeWithClaude(message, senderName) {
  const today = new Date().toLocaleDateString('ru', { 
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
  });
  
  const prompt = `Сегодня: ${today}.
Сообщение от ${senderName} в рабочем SMM-чате: "${message}"

Определи — это задача или нет? Если задача, извлеки данные.
Отвечай ТОЛЬКО JSON:

{
  "is_task": true/false,
  "title": "краткое название задачи (до 60 символов)",
  "priority": "high/medium/low",
  "category": "post/reels/story/analytics/client/other",
  "deadline": "YYYY-MM-DD или null",
  "assigned_to": "имя исполнителя или null",
  "confidence": 0.0-1.0
}

Правила:
- is_task: true только если явно просят что-то сделать
- priority: high если есть "срочно", "сегодня", "завтра"
- deadline: вычисли дату из "до пятницы", "завтра", конкретной даты и т.д.
- assigned_to: имя если в сообщении упомянут конкретный человек
- confidence: уверенность что это реально задача (0.7+ = добавляем)`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  const text = data.content[0].text;
  
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

// Сохраняем задачу в Supabase
async function saveTask(task) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/tasks`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      title: task.title,
      priority: task.priority || 'medium',
      category: task.category || 'other',
      date: task.deadline || null,
      remind: task.assigned_to ? `Назначено: ${task.assigned_to}` : null,
      done: false
    })
  });
  
  return response.ok;
}

// Обрабатываем сообщения в группе
bot.on('message', async (msg) => {
  // Игнорируем личные сообщения и команды
  if (msg.chat.type === 'private') return;
  if (!msg.text || msg.text.startsWith('/')) return;
  
  const text = msg.text;
  const senderName = msg.from.first_name || 'Участник';
  
  // Быстрая проверка — есть ли смысл анализировать
  if (!looksLikeTask(text)) return;
  if (text.length < 10) return;
  
  try {
    const result = await analyzeWithClaude(text, senderName);
    
    // Добавляем только если уверены что это задача
    if (!result || !result.is_task || result.confidence < 0.7) return;
    
    const saved = await saveTask(result);
    
    if (saved) {
      const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
      const categoryEmoji = { 
        post: '✍️', reels: '🎬', story: '📱', 
        analytics: '📊', client: '👤', other: '📌' 
      };
      
      const deadlineStr = result.deadline 
        ? `📅 ${new Date(result.deadline).toLocaleDateString('ru', { day: 'numeric', month: 'long' })}`
        : '📅 Без дедлайна';
      
      const assignedStr = result.assigned_to 
        ? `\n👤 Назначено: ${result.assigned_to}` 
        : '';
      
      await bot.sendMessage(msg.chat.id, 
        `✅ *Задача добавлена в SMM Studio*\n\n` +
        `${categoryEmoji[result.category] || '📌'} ${result.title}\n` +
        `${priorityEmoji[result.priority] || '🟡'} Приоритет: ${result.priority === 'high' ? 'Высокий' : result.priority === 'low' ? 'Низкий' : 'Средний'}\n` +
        `${deadlineStr}${assignedStr}`,
        { parse_mode: 'Markdown', reply_to_message_id: msg.message_id }
      );
    }
  } catch (err) {
    console.error('Ошибка анализа:', err.message);
  }
});

// Команда /tasks — показать активные задачи прямо в чат
bot.onText(/\/tasks/, async (msg) => {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/tasks?done=eq.false&order=date.asc.nullslast&limit=10`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    
    const tasks = await response.json();
    
    if (!tasks.length) {
      bot.sendMessage(msg.chat.id, '🎉 Активных задач нет!');
      return;
    }
    
    const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
    const lines = tasks.map(t => {
      const date = t.date ? new Date(t.date).toLocaleDateString('ru', { day: 'numeric', month: 'short' }) : 'без даты';
      const overdue = t.date && new Date(t.date) < new Date() ? ' ⚠️' : '';
      return `${priorityEmoji[t.priority] || '🟡'} ${t.title} — ${date}${overdue}`;
    });
    
    bot.sendMessage(msg.chat.id,
      `📋 *Активные задачи (${tasks.length}):*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    bot.sendMessage(msg.chat.id, '⚠️ Ошибка загрузки задач');
  }
});

// Команда /done — отметить последнюю задачу выполненной
bot.onText(/\/done (.+)/, async (msg, match) => {
  const search = match[1].toLowerCase();
  
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/tasks?done=eq.false&order=created_at.desc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    
    const tasks = await response.json();
    const task = tasks.find(t => t.title.toLowerCase().includes(search));
    
    if (!task) {
      bot.sendMessage(msg.chat.id, '❌ Задача не найдена');
      return;
    }
    
    await fetch(`${SUPABASE_URL}/rest/v1/tasks?id=eq.${task.id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ done: true })
    });
    
    bot.sendMessage(msg.chat.id, `✅ Выполнено: *${task.title}*`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(msg.chat.id, '⚠️ Ошибка');
  }
});

console.log('SMM Parser Bot запущен ✓');
console.log('Бот слушает чат и автоматически создаёт задачи из сообщений');
