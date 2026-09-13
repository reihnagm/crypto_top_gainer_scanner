import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

if (!token) {
  console.error("Isi TELEGRAM_BOT_TOKEN di file .env terlebih dahulu.");
  process.exit(1);
}

const url = `https://api.telegram.org/bot${token}/getUpdates`;

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(JSON.stringify(data));
  }

  const chats = new Map();

  for (const update of data.result || []) {
    const chat =
      update.message?.chat ||
      update.edited_message?.chat ||
      update.channel_post?.chat ||
      update.callback_query?.message?.chat;

    if (chat?.id != null) {
      chats.set(String(chat.id), {
        chatId: String(chat.id),
        type: chat.type,
        name:
          [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
          chat.title ||
          chat.username ||
          "-",
      });
    }
  }

  if (chats.size === 0) {
    console.log(
      "Belum ada chat. Buka bot Telegram, tekan Start/kirim pesan, lalu jalankan lagi: npm run chatid",
    );
  } else {
    console.table([...chats.values()]);
    console.log("Salin nilai chatId ke TELEGRAM_CHAT_ID di file .env.");
  }
} catch (error) {
  console.error("Gagal mengambil chat ID:", error.message);
  process.exit(1);
}
