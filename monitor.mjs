const BASE_URL = "https://www.seirei.or.jp/hoken/health-reserve/";
const ENTRY_URL = `${BASE_URL}self_login/general`;
const COURSE_ID = process.env.COURSE_ID || "105";
const FACILITY_ID = process.env.FACILITY_ID || "3";
const TARGET_MONTH = process.env.TARGET_MONTH || "2026-07";
const BEFORE_DATE = process.env.BEFORE_DATE || "2026-07-23";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const STATE_FILE = process.env.STATE_FILE || "state/notified.json";

const cookieJar = new Map();

function normalizeMonth(month) {
  const [year, rawMonth] = month.split("-");
  return `${year}-${String(Number(rawMonth)).padStart(2, "0")}`;
}

function apiMonth(month) {
  const [year, rawMonth] = month.split("-");
  return `${year}-${Number(rawMonth)}`;
}

function rememberCookies(headers) {
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie")]
        : [];

  for (const setCookie of setCookies) {
    for (const part of setCookie.split(/,(?=[^;,]+=)/)) {
      const [pair] = part.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}

function cookieHeader() {
  return [...cookieJar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    redirect: "manual",
    ...options,
    headers: {
      "user-agent": "Mozilla/5.0 seirei-health-reserve-monitor/1.0",
      "accept-language": "ja,en-US;q=0.9,en;q=0.8",
      ...(cookieJar.size ? { cookie: cookieHeader() } : {}),
      ...(options.headers || {})
    }
  });
  rememberCookies(response.headers);
  return response;
}

async function follow(url) {
  let currentUrl = url;
  for (let i = 0; i < 10; i++) {
    const response = await request(currentUrl);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, url: currentUrl, text: await response.text() };
    }
    currentUrl = new URL(response.headers.get("location"), currentUrl).toString();
  }
  throw new Error("Too many redirects");
}

function pickInput(html, pattern, label) {
  const match = html.match(pattern);
  if (!match) throw new Error(`${label} was not found`);
  return match[1];
}

async function postDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log(content);
    return;
  }

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content })
  });

  if (!response.ok) {
    throw new Error(`Discord notification failed: ${response.status} ${await response.text()}`);
  }
}

async function readNotifiedDates() {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    return new Set(Array.isArray(data.notifiedDates) ? data.notifiedDates : []);
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
}

async function writeNotifiedDates(notifiedDates) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const data = {
    notifiedDates: [...notifiedDates].sort(),
    updatedAt: new Date().toISOString()
  };
  await writeFile(STATE_FILE, `${JSON.stringify(data, null, 2)}\n`);
}

function availableDates(calendar, targetMonth, beforeDate) {
  const monthKey = normalizeMonth(targetMonth);
  const monthCalendar = calendar?.[monthKey] || {};
  return Object.entries(monthCalendar)
    .filter(([date]) => !beforeDate || date < beforeDate)
    .filter(([, day]) => Number(day?.slot || 0) > 0)
    .map(([date, day]) => ({ date, slot: Number(day.slot) }));
}

function calendarRows(calendar, targetMonth) {
  const monthKey = normalizeMonth(targetMonth);
  const monthCalendar = calendar?.[monthKey] || {};
  return Object.entries(monthCalendar)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => ({
      date,
      slot: Number(day?.slot || 0),
      color: day?.color || "",
      beforeTarget: !BEFORE_DATE || date < BEFORE_DATE
    }));
}

async function main() {
  const { text: step1Html } = await follow(ENTRY_URL);
  const nthUuid = pickInput(step1Html, /id="nthUuid"\s+value="([^"]+)"/, "nthUuid");
  const token = pickInput(step1Html, /name="seirei_hoken_token"\s+value="([^"]+)"/, "seirei_hoken_token");

  const step1Response = await request(`${BASE_URL}api/get_step1/index/${nthUuid}`);
  if (!step1Response.ok) throw new Error(`Step1 API failed: ${step1Response.status}`);
  const step1 = await step1Response.json();
  const course = step1.courses?.[COURSE_ID];
  if (!course) throw new Error(`Course ${COURSE_ID} was not found`);

  const body = new URLSearchParams({
    selectCheckupJson: JSON.stringify([course]),
    seirei_hoken_token: token
  });
  const postResponse = await request(`${BASE_URL}step1/post/${nthUuid}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (![200, 301, 302, 303].includes(postResponse.status)) {
    throw new Error(`Step1 post failed: ${postResponse.status}`);
  }

  const location = postResponse.headers.get("location");
  if (location) await follow(new URL(location, BASE_URL).toString());

  const calendarMonth = apiMonth(TARGET_MONTH);
  const calendarResponse = await request(
    `${BASE_URL}api/get_step2/select_month/${nthUuid}/${FACILITY_ID}/${calendarMonth}`
  );
  if (!calendarResponse.ok) throw new Error(`Calendar API failed: ${calendarResponse.status}`);
  const calendar = await calendarResponse.json();
  const rows = calendarRows(calendar.calendar, TARGET_MONTH);
  if (process.env.PRINT_CALENDAR === "1") {
    for (const row of rows) {
      const mark = row.beforeTarget ? "対象" : "対象外";
      console.log(`${row.date} ${mark} slot=${row.slot} color=${row.color}`);
    }
  }

  const dates = availableDates(calendar.calendar, TARGET_MONTH, BEFORE_DATE);
  const notifiedDates = await readNotifiedDates();
  const newDates = dates.filter(({ date }) => !notifiedDates.has(date));

  const checkedAt = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  if (dates.length === 0) {
    console.log(`[${checkedAt}] No availability for ${TARGET_MONTH} before ${BEFORE_DATE}.`);
    return;
  }

  if (newDates.length === 0) {
    console.log(
      `[${checkedAt}] Availability still exists, but already notified: ${dates
        .map(({ date, slot }) => `${date}(${slot})`)
        .join(", ")}`
    );
    return;
  }

  const lines = newDates.map(({ date, slot }) => `- ${date}: ${slot}枠`);
  await postDiscord(
    [
      "@everyone 健康診断の空きが出ました。",
      `施設: 聖隷健康サポートセンターShizuoka`,
      `コース: 雇入れ時健診`,
      `対象: ${TARGET_MONTH} / ${BEFORE_DATE}より前`,
      ...lines,
      "予約ページ: https://www.seirei.or.jp/hoken/request/health-diagnosis/"
    ].join("\n")
  );

  for (const { date } of newDates) notifiedDates.add(date);
  await writeNotifiedDates(notifiedDates);
}

main().catch(async (error) => {
  const message = `健康診断監視でエラー: ${error.message}`;
  console.error(error);
  if (DISCORD_WEBHOOK_URL) {
    try {
      await postDiscord(message);
    } catch (discordError) {
      console.error(discordError);
    }
  }
  process.exitCode = 1;
});
