import Database from "better-sqlite3";
const db = new Database("bot.db");
db.pragma("journal_mode = WAL");
// Tables
db.exec(`
CREATE TABLE IF NOT EXISTS schools(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS classes(id INTEGER PRIMARY KEY, school_id INTEGER, name TEXT, curator_id INTEGER);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, tg_id INTEGER, role TEXT, class_id INTEGER);
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY, user_id INTEGER, class_id INTEGER, school_id INTEGER, period TEXT, status TEXT, score INTEGER, meta TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS medias(id INTEGER PRIMARY KEY, report_id INTEGER, file_id TEXT, media_type TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, report_id INTEGER, actor_id INTEGER, action TEXT, note TEXT, ts INTEGER);
`);
export default db;

