export default {
  TOKEN: "YOUR_TELEGRAM_BOT_TOKEN_HERE",
  ADMIN_IDS: [123456789], // telegram ids of admins
  PORT: process.env.PORT || 3000,
  WEEK_LIMIT: 3, // default reports per week per class
  PERIOD_TYPE: "week" // default period: week/month/quarter
};