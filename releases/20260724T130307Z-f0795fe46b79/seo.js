const currency = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});

const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const WORKBOOKS = new Set(["xlsx", "xls", "xlsm", "xlsb", "ods"]);
const AUCTION_SPEC_KEY = "sravnikp:auction-spec";
const AUCTION_WORK_KEY = "sravnikp:auction-work";
const ANALYTICS_CONSENT_KEY = "sravnikp:analytics-consent";
const METRIKA_ID = 110997938;

function loadMetrika() {
  if (document.querySelector(`script[data-metrika-id="${METRIKA_ID}"]`)) return;
  window.ym = window.ym || function metrikaQueue(...args) {
    (window.ym.a = window.ym.a || []).push(args);
  };
  window.ym.l = Date.now();
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://mc.yandex.ru/metrika/tag.js?id=${METRIKA_ID}`;
  script.dataset.metrikaId = String(METRIKA_ID);
  document.head.append(script);
  window.ym(METRIKA_ID, "init", {
    accurateTrackBounce: true,
    clickmap: false,
    trackLinks: true,
  });
}

function initializeAnalyticsConsent(banner) {
  let decision = null;
  try {
    decision = localStorage.getItem(ANALYTICS_CONSENT_KEY);
  } catch {
    decision = null;
  }
  if (decision === "accepted") {
    loadMetrika();
    return;
  }
  if (decision === "declined") return;

  const remember = (value) => {
    try {
      localStorage.setItem(ANALYTICS_CONSENT_KEY, value);
    } catch {
      // The choice remains valid for the current page when storage is blocked.
    }
    banner.hidden = true;
  };
  banner.querySelector("[data-analytics-accept]")?.addEventListener("click", () => {
    remember("accepted");
    loadMetrika();
  });
  banner.querySelector("[data-analytics-decline]")?.addEventListener("click", () => remember("declined"));
  banner.hidden = false;
}

function numeric(input, fallback = 0) {
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}

function range(minimum, maximum) {
  const low = Math.min(minimum, maximum);
  const high = Math.max(minimum, maximum);
  return low === high ? currency.format(low) : `${currency.format(low)}–${currency.format(high)}`;
}

function downloadText(fileName, value) {
  const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function initializeWorkSelector(select) {
  select.addEventListener("change", () => {
    const target = select.value;
    if (target && target !== window.location.pathname) window.location.assign(target);
  });
}

function initializeEntranceCalculator(calculator) {
  const pipeRates = { 300: 5200, 400: 7200, 500: 9600, 600: 12800 };
  const surfaceLabels = { crushed: "щебёночное", slabs: "дорожные плиты", asphalt: "асфальт" };
  let specification = "";

  function calculate() {
    const width = Math.max(3, numeric(calculator.querySelector("[data-width]"), 6));
    const ditchWidth = Math.max(0.4, numeric(calculator.querySelector("[data-ditch-width]"), 1.2));
    const depth = Math.max(0.3, numeric(calculator.querySelector("[data-ditch-depth]"), 0.8));
    const diameter = numeric(calculator.querySelector("[data-diameter]"), 400);
    const load = calculator.querySelector("[data-load]").value;
    const surface = calculator.querySelector("[data-surface]").value;
    const distance = Math.max(0, numeric(calculator.querySelector("[data-distance]"), 30));
    const crushedRate = Math.max(0, numeric(calculator.querySelector("[data-crushed-rate]"), 4000));
    const sandRate = Math.max(0, numeric(calculator.querySelector("[data-sand-rate]"), 2200));
    const geotextileRate = Math.max(0, numeric(calculator.querySelector("[data-geotextile-rate]"), 150));
    const heavy = load === "heavy";

    const pipeLength = width + 2;
    const sandVolume = Math.max(1.5, pipeLength * (0.16 + depth * 0.09));
    const crushedVolume = pipeLength * (ditchWidth + 0.8) * (heavy ? 0.55 : 0.32);
    const geotextileArea = pipeLength * (ditchWidth + depth * 2 + 1);
    const excavationVolume = pipeLength * ditchWidth * depth * 0.35 + sandVolume + crushedVolume;
    const pipeCost = pipeLength * (pipeRates[diameter] || pipeRates[400]);
    const surfaceSurcharge = surface === "slabs" ? width * 6500 : surface === "asphalt" ? width * 7800 : 0;
    const aggregateCost = sandVolume * sandRate + crushedVolume * crushedRate + surfaceSurcharge;
    const geotextileCost = geotextileArea * geotextileRate;
    const earthworksCost = Math.max(24000, excavationVolume * 1900) * (heavy ? 1.18 : 1);
    const deliveryAndEnds = 26000 + distance * 180;
    const subtotal = pipeCost + aggregateCost + geotextileCost + earthworksCost + deliveryAndEnds;
    const low = subtotal * 0.85;
    const high = subtotal * 1.15;

    calculator.querySelector("[data-total-result]").textContent = range(low, high);
    calculator.querySelector("[data-pipe-cost]").textContent = range(pipeCost * 0.9, pipeCost * 1.1);
    calculator.querySelector("[data-aggregate-cost]").textContent = range(aggregateCost * 0.9, aggregateCost * 1.1);
    calculator.querySelector("[data-geotextile-cost]").textContent = range(geotextileCost * 0.9, geotextileCost * 1.1);
    calculator.querySelector("[data-earthworks-cost]").textContent = range(earthworksCost * 0.9, earthworksCost * 1.1);
    calculator.querySelector("[data-delivery-cost]").textContent = range(deliveryAndEnds * 0.9, deliveryAndEnds * 1.1);
    calculator.querySelector("[data-material-summary]").textContent = `Труба ${number.format(pipeLength)} м · песок ${number.format(sandVolume)} м³ · щебень ${number.format(crushedVolume)} м³ · геотекстиль ${number.format(geotextileArea)} м²`;

    const warnings = [];
    if (diameter <= 300) warnings.push("Проверьте пропуск воды: калькулятор не выполняет гидравлический расчёт.");
    if (heavy && diameter < 400) warnings.push("Для тяжёлой техники подтвердите диаметр и класс жёсткости трубы после осмотра.");
    if (depth > 1.2) warnings.push("Глубокая канава требует отдельной проверки откосов и высотных отметок.");
    const warning = calculator.querySelector("[data-calculation-warning]");
    warning.hidden = warnings.length === 0;
    warning.textContent = warnings.join(" ");

    specification = [
      "ТЕХНИЧЕСКОЕ ЗАДАНИЕ: ЗАЕЗД НА УЧАСТОК ЧЕРЕЗ КАНАВУ",
      "Регион: Москва и Московская область",
      `Полезная ширина проезда: ${number.format(width)} м`,
      `Канава: ширина ${number.format(ditchWidth)} м, глубина ${number.format(depth)} м`,
      `Труба: диаметр ${diameter} мм, расчётная длина ${number.format(pipeLength)} м; марку и кольцевую жёсткость указать в предложении`,
      `Нагрузка: ${heavy ? "строительная техника" : "легковые автомобили"}`,
      `Покрытие: ${surfaceLabels[surface]}`,
      `Ориентировочные объёмы: песок ${number.format(sandVolume)} м³; щебень ${number.format(crushedVolume)} м³; геотекстиль ${number.format(geotextileArea)} м²`,
      "Отдельными строками указать: подготовку основания, послойную засыпку и уплотнение, доставку, работу техники, укрепление торцов, вывоз лишнего грунта.",
      `Сценарный бюджет по заданным ставкам: ${range(low, high)}. До договора подтвердить объёмы после осмотра.`,
    ].join("\n");
    calculator.dataset.specification = specification;
  }

  calculator.querySelector("form")?.addEventListener("submit", (event) => { event.preventDefault(); calculate(); });
  calculator.querySelectorAll("input, select:not([data-work-select])").forEach((field) => field.addEventListener("input", calculate));
  calculator.querySelector("[data-download-spec]")?.addEventListener("click", () => downloadText("tehzadanie-zaezd-sravnikp.txt", specification));
  calculate();
}

function initializeGenericCalculator(calculator) {
  let specification = "";
  function calculate() {
    const amount = Math.max(0, numeric(calculator.querySelector("[data-generic-amount]")));
    const factor = Math.max(0.1, numeric(calculator.querySelector("[data-generic-factor]"), 1));
    const extra = Math.max(0, numeric(calculator.querySelector("[data-generic-extra]")));
    const rate = Math.max(0, numeric(calculator.querySelector("[data-generic-rate]")));
    const minimum = Math.max(0, Number(calculator.dataset.minimum) || 0);
    const extraRate = Math.max(0, Number(calculator.dataset.extraRate) || 0);
    const locationFactor = Math.max(1, Number(calculator.dataset.locationFactor) || 1);
    const transportSurcharge = Math.max(0, Number(calculator.dataset.transportSurcharge) || 0);
    const locationName = calculator.dataset.locationName || "Москва и Московская область";
    const derivesVolume = calculator.dataset.deriveVolume === "true";
    const calculatedAmount = derivesVolume ? amount * extra : amount;
    const base = Math.max(minimum, calculatedAmount * rate * factor);
    const extraCost = derivesVolume ? 0 : extra * extraRate;
    const logistics = base * (locationFactor - 1) + transportSurcharge;
    const subtotal = base + extraCost + logistics;
    const low = subtotal * 0.88;
    const high = subtotal * 1.18;
    const quantity = derivesVolume ? `${number.format(calculatedAmount)} м³ (${number.format(amount)} сот. × ${number.format(extra)} см)` : `${number.format(amount)} ${calculator.dataset.unit}`;
    calculator.querySelector("[data-generic-total]").textContent = range(low, high);
    calculator.querySelector("[data-generic-quantity]").textContent = quantity;
    calculator.querySelector("[data-generic-base]").textContent = currency.format(base);
    calculator.querySelector("[data-generic-extra-cost]").textContent = derivesVolume ? "Включено в объём" : currency.format(extraCost);
    calculator.querySelector("[data-generic-logistics]").textContent = logistics > 0 ? currency.format(logistics) : "Задайте исполнителю";
    specification = [
      `ТЕХНИЧЕСКОЕ ЗАДАНИЕ: ${document.querySelector("h1")?.textContent?.trim() || "РАБОТЫ НА УЧАСТКЕ"}`,
      `Населённый пункт: ${locationName}`,
      `Расчётный объём: ${quantity}`,
      `Коэффициент условий: ${number.format(factor)}`,
      `Ставка для сравнения: ${currency.format(rate)}`,
      derivesVolume ? `Средняя толщина слоя: ${number.format(extra)} см` : `Дополнительная позиция: ${number.format(extra)} × ${currency.format(extraRate)}`,
      `Локальная модель: коэффициент ${number.format(locationFactor)}, фиксированный выезд ${currency.format(transportSurcharge)}`,
      `Сценарный бюджет: ${range(low, high)}`,
      "В предложении отдельно указать материалы, работы, технику, доставку, вывоз, единицы измерения и итоговый результат.",
      "До договора подтвердить объёмы после осмотра участка.",
    ].join("\n");
    calculator.dataset.specification = specification;
  }
  calculator.querySelector("form")?.addEventListener("submit", (event) => { event.preventDefault(); calculate(); });
  calculator.querySelectorAll("input, select").forEach((field) => field.addEventListener("input", calculate));
  calculator.querySelector("[data-generic-download]")?.addEventListener("click", () => downloadText(`tehzadanie-${calculator.dataset.calculatorType}-sravnikp.txt`, specification));
  calculate();
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function fileExtension(fileName) {
  return fileName.split(".").pop()?.toLocaleLowerCase("ru-RU") || "";
}

async function parseEstimate(module, file) {
  const extension = fileExtension(file.name);
  const supplier = "Подрядчик";
  if (WORKBOOKS.has(extension)) {
    return JSON.parse(module.parseWorkbookFile(supplier, file.name, new Uint8Array(await file.arrayBuffer())));
  }
  if (extension === "docx") {
    return JSON.parse(module.parseDocxFile(supplier, file.name, new Uint8Array(await file.arrayBuffer())));
  }
  if (extension === "pdf") {
    const parsed = JSON.parse(module.parsePdfQuote(supplier, file.name, new Uint8Array(await file.arrayBuffer())));
    return { quote: parsed.quote, warnings: parsed.parse_warnings || [] };
  }
  if (extension === "doc") throw new Error("Старый DOC не поддерживается: сохраните документ как DOCX или PDF");
  const content = await file.text();
  if (extension === "json") {
    const input = JSON.parse(content);
    if (Array.isArray(input.words) && Number.isFinite(input.width) && Number.isFinite(input.height)) {
      const parsed = JSON.parse(module.parseDocForgeQuote(supplier, file.name, content));
      return { quote: parsed.quote, warnings: parsed.parse_warnings || [] };
    }
    if (input.quote?.rows) return input;
    if (Array.isArray(input.rows)) {
      return { quote: { supplier, currency: "RUB", vat_included: true, source_file: file.name, rows: input.rows }, warnings: [] };
    }
    throw new Error("В JSON не найдена таблица строк");
  }
  if (!["csv", "tsv", "txt"].includes(extension)) throw new Error("Поддерживаются PDF, Excel, DOCX, CSV, TSV, TXT и JSON");
  return JSON.parse(module.parseQuoteFile(supplier, file.name, content));
}

function normalize(value) {
  return String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .trim();
}

function auditQuote(quote) {
  const rows = Array.isArray(quote?.rows) ? quote.rows.filter((row) => row?.name && Number.isFinite(row?.unit_price)) : [];
  if (rows.length === 0) throw new Error("Не найдено строк с наименованием и ценой");
  const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row.quantity) || 1) * Math.max(0, row.unit_price), 0);
  const skuCounts = new Map();
  const nameCounts = new Map();
  for (const row of rows) {
    const sku = normalize(row.sku);
    const name = normalize(row.name);
    if (sku) skuCounts.set(sku, (skuCounts.get(sku) || 0) + 1);
    if (name) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  const duplicateRows = rows.filter((row) => {
    const sku = normalize(row.sku);
    return (sku && skuCounts.get(sku) > 1) || nameCounts.get(normalize(row.name)) > 1;
  });
  const materialRows = rows.filter((row) => /(труб|щеб|пес|геотекст|грунт|профнаст|столб|ворот|дрен|бетон|плит)/iu.test(normalize(row.name)));
  const missingSku = materialRows.filter((row) => !normalize(row.sku));
  const missingUnits = rows.filter((row) => !normalize(row.unit));
  const vague = rows.filter((row) => /(^|\s)(прочее|материалы|расходные материалы|расходники|комплект|мелочевка|дополнительные работы|земляные работы|благоустройство|работы под ключ|услуги)(\s|$)/iu.test(normalize(row.name)));
  const largest = rows.reduce((current, row) => {
    const amount = (Number(row.quantity) || 1) * row.unit_price;
    return amount > current.amount ? { row, amount } : current;
  }, { row: rows[0], amount: 0 });
  const flags = [];
  if (duplicateRows.length) flags.push({ level: "high", title: "Похожие строки повторяются", text: `${duplicateRows.length} ${plural(duplicateRows.length, "строка требует", "строки требуют", "строк требуют")} проверки по названию или артикулу.`, question: `Поясните, почему позиции «${duplicateRows.slice(0, 2).map((row) => row.name).join("» и «") }» указаны несколько раз и не перекрывают одну работу.` });
  if (vague.length) flags.push({ level: "high", title: "Есть строки без расшифровки", text: `${vague.length} ${plural(vague.length, "позиция сформулирована", "позиции сформулированы", "позиций сформулированы")} слишком общо.`, question: `Расшифруйте состав, количество и цену позиции «${vague[0].name}».` });
  if (missingSku.length) flags.push({ level: "medium", title: "Не все материалы можно идентифицировать", text: `Для ${missingSku.length} ${plural(missingSku.length, "материала", "материалов", "материалов")} не видны марка или артикул.`, question: "Укажите производителя, марку, характеристики и артикул каждого основного материала." });
  if (missingUnits.length) flags.push({ level: "medium", title: "Не везде видны единицы измерения", text: `${missingUnits.length} ${plural(missingUnits.length, "строка указана", "строки указаны", "строк указаны")} без понятной единицы.`, question: "Укажите количество и единицу измерения каждой позиции: м, м², м³, шт., рейс или машино-смена." });
  if (rows.length > 2 && total > 0 && largest.amount / total >= 0.45) flags.push({ level: "info", title: "Одна строка формирует большую часть итога", text: `«${largest.row.name}» — ${Math.round(largest.amount / total * 100)}% пересчитанной суммы.`, question: `Что именно входит в строку «${largest.row.name}» и можно ли разделить её на работу и детали?` });
  if (flags.length === 0) flags.push({ level: "good", title: "Явных структурных проблем не найдено", text: "Это не подтверждает рыночность цены или правильность технического решения — проверьте объёмы на объекте.", question: "Какой результат, срок и гарантия фиксируются для работ и материалов?" });
  return { rows, total, flags: flags.slice(0, 4), questions: flags.map((flag) => flag.question) };
}

function plural(value, one, few, many) {
  const absolute = Math.abs(value) % 100;
  const last = absolute % 10;
  if (absolute > 10 && absolute < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function sourceLabel(row) {
  if (row.source_page) return `стр. ${row.source_page}, строка ${row.source_row}`;
  if (row.source_sheet) return `${row.source_sheet}, строка ${row.source_row}`;
  return `строка ${row.source_row || "—"}`;
}

function renderAudit(tool, result, warnings, fileName) {
  tool.querySelector("[data-audit-summary]").innerHTML = `<div><span>Файл</span><strong></strong></div><div><span>Строк</span><strong>${result.rows.length}</strong></div><div><span>Пересчитанный итог</span><strong>${currency.format(result.total)}</strong></div>`;
  tool.querySelector("[data-audit-summary] strong").textContent = fileName;
  const flags = tool.querySelector("[data-audit-flags]");
  flags.replaceChildren(...result.flags.slice(0, 2).map((flag) => {
    const article = document.createElement("article");
    article.className = `audit-flag ${flag.level}`;
    const badge = document.createElement("span");
    badge.textContent = flag.level === "high" ? "Проверить" : flag.level === "good" ? "Чисто" : "Уточнить";
    const title = document.createElement("strong");
    title.textContent = flag.title;
    const text = document.createElement("p");
    text.textContent = flag.text;
    article.append(badge, title, text);
    return article;
  }));
  const tbody = tool.querySelector("[data-audit-rows]");
  tbody.replaceChildren(...result.rows.slice(0, 100).map((row) => {
    const tr = document.createElement("tr");
    const amount = (Number(row.quantity) || 1) * row.unit_price;
    for (const value of [sourceLabel(row), row.sku || "—", row.name, number.format(row.quantity || 1), currency.format(row.unit_price), currency.format(amount)]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    return tr;
  }));
  if (result.rows.length > 100) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = `Показаны первые 100 из ${result.rows.length} строк.`;
    tr.append(td);
    tbody.append(tr);
  }
  const status = tool.querySelector("[data-audit-status]");
  status.textContent = warnings?.length ? `Документ распознан. Предупреждения: ${warnings.slice(0, 2).join(" · ")}` : "Документ распознан и проверен локально.";
  tool.dataset.questions = result.questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
  tool.dataset.specification = [
    "ПРОВЕРЕННАЯ СМЕТА РАБОТ НА УЧАСТКЕ",
    `Файл: ${fileName}`,
    `Распознано строк: ${result.rows.length}`,
    `Пересчитанный итог: ${currency.format(result.total)}`,
    `Вопросы к исходной смете:\n${tool.dataset.questions}`,
  ].join("\n");
  tool.querySelector("[data-audit-results]").hidden = false;
}

function initializeAudit(tool) {
  const input = tool.querySelector("[data-audit-input]");
  const drop = tool.querySelector("[data-audit-drop]");
  const status = tool.querySelector("[data-audit-status]");
  const error = tool.querySelector("[data-audit-error]");
  let modulePromise;

  function loadModule() {
    if (!modulePromise) {
      const url = document.querySelector("main").dataset.wasmModule;
      modulePromise = import(url).then(async (module) => {
        await module.default();
        return module;
      });
    }
    return modulePromise;
  }

  async function process(file) {
    if (!file) return;
    error.hidden = true;
    tool.querySelector("[data-audit-results]").hidden = true;
    if (file.size === 0) {
      error.textContent = "Файл пуст.";
      error.hidden = false;
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      error.textContent = "Файл больше 25 МБ.";
      error.hidden = false;
      return;
    }
    status.textContent = "Запускаем локальный движок и читаем таблицу…";
    try {
      const module = await loadModule();
      const parsed = await parseEstimate(module, file);
      const result = auditQuote(parsed.quote);
      renderAudit(tool, result, parsed.warnings || [], file.name);
    } catch (caught) {
      status.textContent = "Документ не обработан.";
      error.textContent = caught instanceof Error ? caught.message : String(caught);
      error.hidden = false;
    }
  }

  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (event) => {
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      input.click();
    }
  });
  for (const name of ["dragenter", "dragover"]) drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add("dragging"); });
  for (const name of ["dragleave", "drop"]) drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove("dragging"); });
  drop.addEventListener("drop", (event) => process(event.dataTransfer.files[0]));
  input.addEventListener("change", () => process(input.files[0]));
  tool.querySelector("[data-copy-questions]").addEventListener("click", async (event) => {
    await copyText(`Вопросы к смете подрядчика:\n${tool.dataset.questions}`);
    event.currentTarget.textContent = "Вопросы скопированы";
  });
  tool.querySelector("[data-reset-audit]").addEventListener("click", () => {
    input.value = "";
    tool.querySelector("[data-audit-results]").hidden = true;
    error.hidden = true;
    status.textContent = "Движок загрузится только после выбора файла.";
    drop.focus();
  });
}

function currentSpecification() {
  return document.querySelector("[data-entrance-calculator], [data-generic-calculator], [data-audit-tool]")?.dataset.specification || "";
}

function initializeAuctionLink(link) {
  link.addEventListener("click", () => {
    const specification = currentSpecification();
    if (specification) sessionStorage.setItem(AUCTION_SPEC_KEY, specification);
    if (link.dataset.auctionWork) sessionStorage.setItem(AUCTION_WORK_KEY, link.dataset.auctionWork);
  });
}

function auctionMailto(tool, form) {
  const data = new FormData(form);
  const select = form.querySelector("[data-auction-work-select]");
  const work = select.options[select.selectedIndex]?.textContent?.trim() || data.get("work") || "Работа на участке";
  const specification = sessionStorage.getItem(AUCTION_SPEC_KEY) || "Техническое задание ещё не сформировано; уточните объём в ответном письме.";
  const subject = `Заявка в аукцион: ${work} — ${data.get("locality") || "Москва и МО"}`;
  const body = [
    "ЗАЯВКА В ПИЛОТНЫЙ АУКЦИОН СРАВНИКП",
    "",
    `Работа: ${work}`,
    `Населённый пункт: ${data.get("locality") || ""}`,
    `Как обращаться: ${data.get("name") || ""}`,
    `Телефон или Telegram: ${data.get("contact") || ""}`,
    `Когда можно начать: ${data.get("start") || ""}`,
    `Как ответить: ${data.get("reply") || ""}`,
    `Комментарий: ${data.get("comment") || "—"}`,
    "",
    "ТЕХНИЧЕСКОЕ ЗАДАНИЕ ИЗ КАЛЬКУЛЯТОРА",
    specification,
    "",
    "Согласие: можно передать обезличенное задание не более чем пяти подрядчикам. Контакт и точный адрес — только выбранному мной исполнителю.",
  ].join("\n");
  return `mailto:${tool.dataset.auctionEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function initializeAuctionTool(tool) {
  const form = tool.querySelector("[data-auction-form]");
  const select = form.querySelector("[data-auction-work-select]");
  const requestedWork = new URLSearchParams(window.location.search).get("work");
  const savedWork = sessionStorage.getItem(AUCTION_WORK_KEY);
  const work = requestedWork || savedWork;
  if (work && [...select.options].some((option) => option.value === work)) select.value = work;

  const updateDraft = () => { form.dataset.auctionMailto = auctionMailto(tool, form); };
  form.addEventListener("input", updateDraft);
  form.addEventListener("change", updateDraft);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    updateDraft();
    tool.querySelector("[data-auction-status]").textContent = "Почтовая программа открыта. Проверьте заявку и нажмите «Отправить». До этого момента данные никуда не переданы.";
    window.location.href = form.dataset.auctionMailto;
  });
  updateDraft();
}

document.querySelectorAll("[data-work-select]").forEach(initializeWorkSelector);
document.querySelectorAll("[data-entrance-calculator]").forEach(initializeEntranceCalculator);
document.querySelectorAll("[data-generic-calculator]").forEach(initializeGenericCalculator);
document.querySelectorAll("[data-audit-tool]").forEach(initializeAudit);
document.querySelectorAll("[data-auction-link]").forEach(initializeAuctionLink);
document.querySelectorAll("[data-auction-tool]").forEach(initializeAuctionTool);
document.querySelectorAll("[data-analytics-consent]").forEach(initializeAnalyticsConsent);
