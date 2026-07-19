const currency = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});

const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const WORKBOOKS = new Set(["xlsx", "xls", "xlsm", "xlsb", "ods"]);

function numeric(input, fallback = 0) {
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}

function range(minimum, maximum) {
  const low = Math.min(minimum, maximum);
  const high = Math.max(minimum, maximum);
  return low === high ? currency.format(low) : `${currency.format(low)}–${currency.format(high)}`;
}

function initializeCalculator(calculator) {
  const rateInput = calculator.querySelector("[data-hour-rate]");
  const partsMinInput = calculator.querySelector("[data-parts-min]");
  const partsMaxInput = calculator.querySelector("[data-parts-max]");
  const complexityInput = calculator.querySelector("[data-complexity]");
  const hoursMinInput = calculator.querySelector("[data-hours-min-input]");
  const hoursMaxInput = calculator.querySelector("[data-hours-max-input]");
  const operationSelect = calculator.querySelector("[data-operation-select]");

  function hours() {
    return [
      hoursMinInput ? numeric(hoursMinInput, 1) : Number(calculator.dataset.hoursMin),
      hoursMaxInput ? numeric(hoursMaxInput, 2) : Number(calculator.dataset.hoursMax),
    ];
  }

  function calculate() {
    const [hoursMin, hoursMax] = hours();
    const rate = Math.max(0, numeric(rateInput));
    const multiplier = Math.max(0.5, numeric(complexityInput, 1));
    const partsMin = Math.max(0, numeric(partsMinInput));
    const partsMax = Math.max(0, numeric(partsMaxInput));
    const laborMin = Math.min(hoursMin, hoursMax) * rate * multiplier;
    const laborMax = Math.max(hoursMin, hoursMax) * rate * multiplier;
    const totalMin = laborMin + Math.min(partsMin, partsMax);
    const totalMax = laborMax + Math.max(partsMin, partsMax);
    calculator.querySelector("[data-labor-result]").textContent = range(laborMin, laborMax);
    calculator.querySelector("[data-parts-result]").textContent = range(partsMin, partsMax);
    calculator.querySelector("[data-total-result]").textContent = range(totalMin, totalMax);
    calculator.querySelector("[data-formula]").textContent = `${number.format(Math.min(hoursMin, hoursMax))}–${number.format(Math.max(hoursMin, hoursMax))} н·ч × ${currency.format(rate)} × ${number.format(multiplier)} + детали`;
    calculator.dataset.copyText = `Расчёт СТО‑Чек: работа ${range(laborMin, laborMax)}, детали ${range(partsMin, partsMax)}, ориентир итога ${range(totalMin, totalMax)}. Ставка ${currency.format(rate)}/нормочас.`;
  }

  operationSelect?.addEventListener("change", () => {
    const option = operationSelect.selectedOptions[0];
    calculator.dataset.hoursMin = option.dataset.hoursMin;
    calculator.dataset.hoursMax = option.dataset.hoursMax;
    partsMinInput.value = option.dataset.partsMin;
    partsMaxInput.value = option.dataset.partsMax;
    calculate();
  });
  calculator.querySelectorAll("input, select").forEach((field) => field.addEventListener("input", calculate));
  calculator.querySelector("[data-copy-result]")?.addEventListener("click", async (event) => {
    await copyText(calculator.dataset.copyText || "");
    const original = event.currentTarget.textContent;
    event.currentTarget.textContent = "Расчёт скопирован";
    setTimeout(() => { event.currentTarget.textContent = original; }, 1800);
  });
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
  const supplier = "Автосервис";
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
  const missingSku = rows.filter((row) => !normalize(row.sku));
  const vague = rows.filter((row) => /(^|\s)(прочее|расходные материалы|расходники|комплект|мелочевка|дополнительные работы|слесарные работы|ремонтные работы)(\s|$)/iu.test(normalize(row.name)));
  const hourRows = rows.filter((row) => /(нормо.?час|н.?ч|час)/iu.test(`${row.unit || ""} ${row.name || ""}`));
  const largest = rows.reduce((current, row) => {
    const amount = (Number(row.quantity) || 1) * row.unit_price;
    return amount > current.amount ? { row, amount } : current;
  }, { row: rows[0], amount: 0 });
  const flags = [];
  if (duplicateRows.length) flags.push({ level: "high", title: "Похожие строки повторяются", text: `${duplicateRows.length} ${plural(duplicateRows.length, "строка требует", "строки требуют", "строк требуют")} проверки по названию или артикулу.`, question: `Поясните, почему позиции «${duplicateRows.slice(0, 2).map((row) => row.name).join("» и «") }» указаны несколько раз и не перекрывают одну работу.` });
  if (vague.length) flags.push({ level: "high", title: "Есть строки без расшифровки", text: `${vague.length} ${plural(vague.length, "позиция сформулирована", "позиции сформулированы", "позиций сформулированы")} слишком общо.`, question: `Расшифруйте состав, количество и цену позиции «${vague[0].name}».` });
  if (missingSku.length) flags.push({ level: "medium", title: "Не везде указаны артикулы", text: `Без артикула нельзя надёжно сравнить ${missingSku.length} ${plural(missingSku.length, "деталь", "детали", "деталей")} с другим предложением.`, question: "Укажите артикулы, производителей и состояние деталей: новые, восстановленные или бывшие в употреблении." });
  if (hourRows.length === 0) flags.push({ level: "medium", title: "Не видны нормочасы и ставка", text: "В распознанных строках нет явного разбиения стоимости работ на время и ставку.", question: "Сколько нормочасов заложено по каждой работе и какая ставка используется?" });
  if (rows.length > 2 && total > 0 && largest.amount / total >= 0.45) flags.push({ level: "info", title: "Одна строка формирует большую часть итога", text: `«${largest.row.name}» — ${Math.round(largest.amount / total * 100)}% пересчитанной суммы.`, question: `Что именно входит в строку «${largest.row.name}» и можно ли разделить её на работу и детали?` });
  if (flags.length === 0) flags.push({ level: "good", title: "Явных структурных проблем не найдено", text: "Это не подтверждает необходимость или рыночность работ — проверьте диагностику, гарантию и состав деталей.", question: "Какая гарантия действует на работы и детали и что потребуется для гарантийного обращения?" });
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
    await copyText(`Вопросы к смете СТО:\n${tool.dataset.questions}`);
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

document.querySelectorAll("[data-calculator]").forEach(initializeCalculator);
document.querySelectorAll("[data-audit-tool]").forEach(initializeAudit);
