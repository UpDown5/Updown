import db from "./db.js";
import express from "express";
import multer from "multer";
import fs from "fs";

const bot = new Telegraf(config.TOKEN);
bot.use(session());

// Simple state machine stored in session
bot.start(async (ctx) => {
  const tgId = ctx.from.id;
  ctx.session = {};
  // Ensure user exists
  let user = db.prepare("SELECT * FROM users WHERE tg_id=?").get(tgId);
  if (!user) {
    db.prepare("INSERT INTO users(tg_id, role) VALUES(?,?)").run(tgId, "student");
    user = db.prepare("SELECT * FROM users WHERE tg_id=?").get(tgId);
  }
  // add admin options for admins
  const isAdmin = config.ADMIN_IDS.includes(tgId);
  const baseButtons = [
    ["Новый отчёт","Мои отчёты"],
    ["Рейтинг","Правила и как считать"],
    ["Связь с админом"]
  ];
  if (isAdmin) baseButtons.push(["Админ: выгрузка","Админ: итоги"]);
  await ctx.reply("Меню", Markup.keyboard(baseButtons).resize());
});

// New report flow
bot.hears("Новый отчёт", async (ctx) => {
  ctx.session.report = {};
  // ask school
  const schools = db.prepare("SELECT id,name FROM schools").all();
  if (schools.length === 0) return ctx.reply("Пока нет добавленных школ. Свяжитесь с админом.");
  const buttons = schools.map(s => [Markup.button.callback(s.name, `school_${s.id}`)]);
  ctx.session._step = "choose_school";
  await ctx.reply("Выберите школу:", Markup.inlineKeyboard(buttons));
});

bot.action(/school_(\d+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  ctx.session.report = { school_id: id };
  // list classes
  const classes = db.prepare("SELECT id,name FROM classes WHERE school_id=?").all(id);
  if (classes.length === 0) return ctx.editMessageText("Нет классов в этой школе.");
  const buttons = classes.map(c => [Markup.button.callback(c.name, `class_${c.id}`)]);
  ctx.session._step = "choose_class";
  await ctx.editMessageText("Выберите класс:", Markup.inlineKeyboard(buttons));
});

bot.action(/class_(\d+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  ctx.session.report.class_id = id;
  ctx.session._step = "choose_fractions";
  // simple fractions selection
  await ctx.editMessageText("Отметьте фракции (через запятую). Пример: пластик, бумага");
  await ctx.reply("Напишите фракции, затем объём (например: пластик, бумага\nОбъём: 12.5 кг)\n(В следующем сообщении прикрепите фото/видео)");
});

// receive fractions, volume and expect media next
bot.on("message", async (ctx) => {
  if (!ctx.session || !ctx.session._step) {
    // admin quick actions via keyboard buttons
    if (ctx.message.text === "Админ: выгрузка") return exportCsvCommand(ctx);
    if (ctx.message.text === "Админ: итоги") return summaryCommand(ctx);
    return;
  }
  const step = ctx.session._step;
  if (step === "choose_fractions" && ctx.message.text) {
    // parse text lines for fractions and volume
    const lines = ctx.message.text.split("\n").map(s=>s.trim()).filter(Boolean);
    const fractionsLine = lines[0] || "";
    const volLine = lines.find(l => /объ/i) || "";
    ctx.session.report.fractions = fractionsLine.split(",").map(s=>s.trim()).filter(Boolean);
    ctx.session.report.volume = volLine.replace(/[^\d.,]/g,"").replace(",",".") || "";
    ctx.session._step = "await_media";
    return ctx.reply("Прикрепите фото или видео и нажмите отправить (сообщением).");
  }
  if (step === "await_media" && (ctx.message.photo || ctx.message.video)) {
    // save report
    const tgId = ctx.from.id;
    const user = db.prepare("SELECT * FROM users WHERE tg_id=?").get(tgId);
    const period = getCurrentPeriod();
    const meta = JSON.stringify({
      fractions: ctx.session.report.fractions,
      volume: ctx.session.report.volume
    });
    const info = db.prepare("INSERT INTO reports(user_id,class_id,school_id,period,status,score,meta,created_at) VALUES(?,?,?,?,?,?,?,?)").run(
      user.id, ctx.session.report.class_id, ctx.session.report.school_id, period, "pending_class", 0, meta, Date.now()
    );
    const reportId = info.lastInsertRowid;
    // store media file_id(s)
    if (ctx.message.photo) {
      const largest = ctx.message.photo.pop();
      db.prepare("INSERT INTO medias(report_id,file_id,media_type) VALUES(?,?,?)").run(reportId, largest.file_id, "photo");
    }
    if (ctx.message.video) {
      db.prepare("INSERT INTO medias(report_id,file_id,media_type) VALUES(?,?,?)").run(reportId, ctx.message.video.file_id, "video");
    }
    ctx.session._step = null;
    // notify class curator
    const cls = db.prepare("SELECT * FROM classes WHERE id=?").get(ctx.session.report.class_id);
    if (cls && cls.curator_id) {
      try { await bot.telegram.sendMessage(cls.curator_id, `Новый отчёт от класса ${cls.name} — /moderate_${reportId}`); } catch(e){}
    }
    return ctx.reply("Отчёт отправлен на проверку куратору класса.");
  }
});

// class curator moderation command (simple)
bot.command(/moderate_(\d+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const report = db.prepare("SELECT r.*, c.name as class_name FROM reports r LEFT JOIN classes c ON r.class_id=c.id WHERE r.id=?").get(id);
  if (!report) return ctx.reply("Отчёт не найден.");
  // check curator permission
  const user = db.prepare("SELECT * FROM users WHERE tg_id=?").get(ctx.from.id);
  if (!user || user.role !== "curator") return ctx.reply("Нет доступа.");
  await ctx.replyWithMarkdown(`Отчёт #${id}\nКласс: ${report.class_name}\nСтатус: ${report.status}`, Markup.inlineKeyboard([
    Markup.button.callback("Подтвердить", `class_confirm_${id}`),
    Markup.button.callback("Вернуть на доработку", `class_reject_${id}`)
  ]));
});

bot.action(/class_confirm_(\d+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  db.prepare("UPDATE reports SET status=? WHERE id=?").run("pending_school", id);
  // notify school curator
  const rep = db.prepare("SELECT * FROM reports WHERE id=?").get(id);
  const cls = db.prepare("SELECT * FROM classes WHERE id=?").get(rep.class_id);
  if (cls && cls.curator_id) try { await bot.telegram.sendMessage(cls.curator_id, `Отчёт #${id} подтверждён куратором класса. /schoolmod_${id}`); } catch(e){}
  await ctx.editMessageText("Отчёт отправлен куратору школы.");
});

bot.action(/class_reject_(\d+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  db.prepare("UPDATE reports SET status=? WHERE id=?").run("needs_fix", id);
  const rep = db.prepare("SELECT * FROM reports WHERE id=?").get(id);
  const user = db.prepare("SELECT tg_id FROM users WHERE id=?").get(rep.user_id);
  if (user) try { await bot.telegram.sendMessage(user.tg_id, `Ваш отчёт #${id} возвращён на доработку.`); } catch(e){}
  await ctx.editMessageText("Отчёт возвращён автору.");
});

// school moderator command
bot.command(/schoolmod_(\d+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const user = db.prepare("SELECT * FROM users WHERE tg_id=?").get(ctx.from.id);
  if (!user || user.role !== "school_curator") return ctx.reply("Нет доступа.");
  await ctx.replyWithMarkdown(`Модерация отчёта #${id}`, Markup.inlineKeyboard([
    Markup.button.callback("Принять в зачёт", `school_accept_${id}`),
    Markup.button.callback("Отклонить", `school_reject_${id}`)
  ]));
});

bot.action(/school_accept_(\d+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  // compute score (simple example)
  const rep = db.prepare("SELECT * FROM reports WHERE id=?").get(id);
  const meta = JSON.parse(rep.meta || "{}");
  let score = 10; // base
  score += (meta.fractions ? meta.fractions.length : 0) * 2;
  score += Math.min(20, Number(rep.volume) || Number(meta.volume) || 0);
  db.prepare("UPDATE reports SET status=?, score=? WHERE id=?").run("accepted", score, id);
  // notify author
  const user = db.prepare("SELECT tg_id FROM users WHERE id=?").get(rep.user_id);
  if (user) try { await bot.telegram.sendMessage(user.tg_id, `Ваш отчёт #${id} принят. Баллы: ${score}`); } catch(e){}
  await ctx.editMessageText("Отчёт принят и записан в зачёт.");
});

bot.action(/school_reject_(\d+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  db.prepare("UPDATE reports SET status=? WHERE id=?").run("rejected", id);
  const rep = db.prepare("SELECT * FROM reports WHERE id=?").get(id);
  const user = db.prepare("SELECT tg_id FROM users WHERE id=?").get(rep.user_id);
  if (user) try { await bot.telegram.sendMessage(user.tg_id, `Ваш отчёт #${id} отклонён.`); } catch(e){}
  await ctx.editMessageText("Отчёт отклонён.");
});

// simple commands: Мои отчёты, Рейтинг, Правила
bot.hears("Мои отчёты", async (ctx) => {
  const user = db.prepare("SELECT * FROM users WHERE tg_id=?").get(ctx.from.id);
  if (!user) return ctx.reply("Пользователь не найден.");
  const reports = db.prepare("SELECT * FROM reports WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(user.id);
  if (reports.length === 0) return ctx.reply("Нет отчётов.");
  for (const r of reports) {
    await ctx.reply(`#${r.id} Статус: ${r.status} Баллы:${r.score} Период:${r.period}`);
  }
});

bot.hears("Рейтинг", async (ctx) => {
  // simple aggregate by class
  const rows = db.prepare("SELECT c.name, SUM(r.score) as total FROM reports r JOIN classes c ON r.class_id=c.id WHERE r.status='accepted' GROUP BY r.class_id ORDER BY total DESC LIMIT 10").all();
  if (rows.length===0) return ctx.reply("Нет данных для рейтинга.");
  let msg = "Топ классов:\n";
  rows.forEach((r,i)=> msg += `${i+1}. ${r.name} — ${r.total||0}\n`);
  await ctx.reply(msg);
});

// ADMIN TELEGRAM COMMANDS: /export_csv and /summary — only for ADMIN_IDS
async function exportCsvCommand(ctx) {
  const tgId = ctx.from.id;
  if (!config.ADMIN_IDS.includes(tgId)) return ctx.reply("Нет доступа.");
  const rows = db.prepare("SELECT r.*, c.name as class_name, s.name as school_name FROM reports r LEFT JOIN classes c ON r.class_id=c.id LEFT JOIN schools s ON r.school_id=s.id").all();
  const header = "id,user_id,class,school,period,status,score,meta,created_at\n";
  const csv = header + rows.map(r=> `${r.id},${r.user_id},"${r.class_name || ''}","${r.school_name || ''}",${r.period},${r.status},${r.score},"${(r.meta||'').replace(/"/g,'""')}",${r.created_at}`).join("\n");
  // write to temp file and send
  const tmpPath = `./reports_export_${Date.now()}.csv`;
  fs.writeFileSync(tmpPath, csv);
  try {
    await ctx.replyWithDocument({ source: fs.createReadStream(tmpPath), filename: "reports.csv" });
  } catch (e) {
    await ctx.reply("Ошибка отправки CSV.");
  } finally {
    try { fs.unlinkSync(tmpPath); } catch(e){}
  }
}

async function summaryCommand(ctx) {
  const tgId = ctx.from.id;
  if (!config.ADMIN_IDS.includes(tgId)) return ctx.reply("Нет доступа.");
  // build simple summary: top schools, total reports, accepted counts, best media count
  const totalReports = db.prepare("SELECT COUNT(*) as c FROM reports").get().c;
  const accepted = db.prepare("SELECT COUNT(*) as c FROM reports WHERE status='accepted'").get().c;
  const perSchool = db.prepare("SELECT s.name, COUNT(r.id) as c, SUM(r.score) as points FROM reports r LEFT JOIN schools s ON r.school_id=s.id GROUP BY r.school_id ORDER BY points DESC LIMIT 5").all();
  let msg = `Сводка:\nВсего отчётов: ${totalReports}\nПринято: ${accepted}\n\nТоп школ по баллам:\n`;
  perSchool.forEach((s,i)=> msg += `${i+1}. ${s.name||'—'} — отчётов ${s.c} баллы ${s.points||0}\n`);
  await ctx.reply(msg);
}

// Map admin keyboard buttons to commands
bot.hears("Админ: выгрузка", exportCsvCommand);
bot.hears("Админ: итоги", summaryCommand);

// simple text info/help
bot.hears("Правила и как считать", async (ctx) => {
  await ctx.reply("Короткие правила:\n1) Обязательное фото/видео\n2) Ограничение по числу отчётов в неделю\n3) Ручная модерация спорных — через бота");
});

bot.hears("Связь с админом", async (ctx) => {
  await ctx.reply("Напишите сообщение, а админ получит его (реализация — позже).");
});

bot.launch();

// express admin minimal UI to view exports and trigger summary
const app = express();
app.use(express.json());
// keep static admin page local but remove public CSV endpoint to avoid duplication
app.get("/", (req,res)=> res.sendFile(new URL("index.html", import.meta.url).pathname));
// remove /export/csv endpoint — admin export is now in Telegram
// app.get("/export/csv", (req,res)=>{
//   const rows = db.prepare("SELECT r.*, c.name as class_name, s.name as school_name FROM reports r LEFT JOIN classes c ON r.class_id=c.id LEFT JOIN schools s ON r.school_id=s.id").all();
//   const header = "id,user_id,class,school,period,status,score,meta,created_at\n";
//   const csv = rows.map(r=> `${r.id},${r.user_id},\"${r.class_name}\",\"${r.school_name}\",${r.period},${r.status},${r.score},\"${r.meta}\",${r.created_at}`).join("\n");
//   res.setHeader("Content-Type","text/csv");
//   res.send(header+csv);
// });
app.listen(config.PORT, ()=> console.log("Admin UI on port", config.PORT));

function getCurrentPeriod(){
  const d = new Date();
  if (config.PERIOD_TYPE === "week") {
    const onejan = new Date(d.getFullYear(),0,1);
    const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay()+1)/7));
    return `${d.getFullYear()}-W${week}`;
  }
  if (config.PERIOD_TYPE === "month") return `${d.getFullYear()}-${d.getMonth()+1}`;
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth()/3)+1}`;
}