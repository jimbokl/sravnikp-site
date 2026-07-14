import initWasm, {
  compareQuotes,
  engineVersion,
  exportComparisonCsv,
  parseDocForgeQuote,
  parseDocxFile,
  parsePdfQuote,
  parseQuoteFile,
  parseWorkbookFile,
} from "./pkg/svodkp_wasm.js";

const MAX_FILES = 10;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
const MAX_ROWS_PER_FILE = 50_000;
const DEFAULT_VAT_RATE = 0.22;
const VAT_RATE_OPTIONS = [
  [0.22, "22% · основная"],
  [0.20, "20% · до 2026"],
  [0.10, "10%"],
  [0.07, "7% · УСН"],
  [0.05, "5% · УСН"],
  [0, "0%"],
];
const TEXT_EXTENSIONS = new Set(["csv", "tsv", "txt", "json"]);
const WORKBOOK_EXTENSIONS = new Set(["xlsx", "xls", "xlsm", "xlsb", "ods"]);
const DOCUMENT_EXTENSIONS = new Set(["docx"]);
const DATABASE_NAME = "sravnikp-local";
const DATABASE_VERSION = 1;
const PROJECT_STORE = "projects";
const PROJECT_KEY = "current";
let databasePromise;

const state = {
  ready: false,
  processing: false,
  entries: [],
  result: null,
  nextId: 1,
  saveTimer: null,
  approvedMatches: new Set(),
};

const elements = {
  engineLight: document.querySelector("#engine-light"),
  engineStatus: document.querySelector("#engine-status"),
  engineVersion: document.querySelector("#engine-version"),
  storageStatus: document.querySelector("#storage-status"),
  dropZone: document.querySelector("#drop-zone"),
  fileInput: document.querySelector("#file-input"),
  quoteList: document.querySelector("#quote-list"),
  demoButton: document.querySelector("#demo-button"),
  heroDemoButton: document.querySelector("#hero-demo-button"),
  clearButton: document.querySelector("#clear-button"),
  compareButton: document.querySelector("#compare-button"),
  inlineError: document.querySelector("#inline-error"),
  results: document.querySelector("#results"),
  resultStatus: document.querySelector("#result-status"),
  summaryGrid: document.querySelector("#summary-grid"),
  resultWarnings: document.querySelector("#result-warnings"),
  resultHead: document.querySelector("#result-head"),
  resultBody: document.querySelector("#result-body"),
  exportButton: document.querySelector("#export-button"),
};

const demoFiles = [
  {
    name: "КП_АльфаСнаб.csv",
    supplier: "АльфаСнаб",
    content: `Артикул;Наименование;Количество;Ед. изм.;Цена;Срок поставки
A-100;Клапан шаровой DN20;24;шт;1 240,00;4
A-120;Манометр радиальный 0-10 бар;12;шт;890,00;3
P-2560;Насос циркуляционный 25/60;6;шт;8 490,00;7
G-210;Прокладка медная 20 мм;100;шт;19,50;2`,
  },
  {
    name: "КП_БетаИнжиниринг.csv",
    supplier: "Бета Инжиниринг",
    content: `Артикул,Наименование,Количество,Ед.,Цена,Срок дней
A100,"Шаровый клапан, DN 20",24,шт,1080.00,6
A-120,Манометр 0–10 бар радиальный,12,шт,920.00,2
P2560,Циркуляционный насос 25-60,6,шт,7950.00,10
G210,Медная прокладка 20мм,100,шт,18.00,4`,
  },
  {
    name: "Прайс_ТехКомплект.tsv",
    supplier: "ТехКомплект",
    content: `Код\tОписание\tКол-во\tЕдиница\tСтоимость\tДоставка дней
A-100\tКран шаровой DN20\t24\tшт\t1185\t5
A-120\tМанометр радиал. 10 бар\t12\tшт\t875\t8
P-2560\tНасос 25/60 циркуляционный\t6\tшт\t8120\t5
G-210\tПрокладка медная D20\t100\tшт\t18.8\t3`,
  },
];

boot();

async function boot() {
  bindEvents();
  try {
    await initWasm();
    state.ready = true;
    elements.engineLight.classList.add("ready");
    elements.engineStatus.textContent = "Движок готов · файлы остаются в браузере";
    elements.engineVersion.textContent = engineVersion();
    await restoreWorkspace();
    syncControls();
  } catch (error) {
    elements.engineLight.classList.add("error");
    elements.engineStatus.textContent = "Не удалось запустить локальный движок";
    showError(formatError(error));
  }
}

function bindEvents() {
  elements.dropZone.addEventListener("click", () => elements.fileInput.click());
  elements.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.fileInput.click();
    }
  });
  elements.fileInput.addEventListener("change", async (event) => {
    await processFiles([...event.target.files]);
    event.target.value = "";
  });
  for (const eventName of ["dragenter", "dragover"]) {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("dragging");
    });
  }
  elements.dropZone.addEventListener("drop", async (event) => {
    await processFiles([...event.dataTransfer.files]);
  });
  elements.demoButton.addEventListener("click", loadDemo);
  elements.heroDemoButton.addEventListener("click", async () => {
    await loadDemo();
    document.querySelector("#workspace").scrollIntoView({ behavior: "smooth" });
  });
  elements.clearButton.addEventListener("click", clearWorkspace);
  elements.compareButton.addEventListener("click", runComparison);
  elements.exportButton.addEventListener("click", exportCsv);
}

async function processFiles(files) {
  if (!state.ready || state.processing || files.length === 0) return;
  hideError();
  const errors = [];
  const remainingSlots = Math.max(0, MAX_FILES - state.entries.length);
  if (files.length > remainingSlots) {
    errors.push(`Можно добавить не больше ${MAX_FILES} файлов; лишние файлы не обработаны`);
  }
  const candidates = files.slice(0, remainingSlots);
  let totalSize = state.entries.reduce((sum, entry) => sum + entry.fileSize, 0);
  state.processing = true;
  syncControls();

  try {
    for (const [index, file] of candidates.entries()) {
      elements.engineStatus.textContent = `Обрабатываем ${index + 1} из ${candidates.length}: ${file.name}`;
      await nextFrame();
      try {
        const extension = fileExtension(file.name);
        if (extension === "doc") {
          throw new Error("старый формат DOC не поддерживается; сохраните документ как DOCX или PDF");
        }
        if (![...TEXT_EXTENSIONS, ...WORKBOOK_EXTENSIONS, ...DOCUMENT_EXTENSIONS, "pdf"].includes(extension)) {
          throw new Error("поддерживаются CSV, TSV, JSON, Excel/OpenDocument, DOCX и текстовые PDF");
        }
        if (file.size === 0) throw new Error("файл пуст");
        if (file.size > MAX_FILE_SIZE) throw new Error("файл больше 25 МБ");
        if (totalSize + file.size > MAX_TOTAL_SIZE) {
          throw new Error("общий объём файлов превышает 100 МБ");
        }

        const supplier = supplierFromFilename(file.name);
        const entry = await parseInputFile(supplier, file);
        validateParsedEntry(entry);
        state.entries.push({
          id: state.nextId++,
          fileName: file.name,
          fileSize: file.size,
          ...entry,
        });
        totalSize += file.size;
      } catch (error) {
        errors.push(`${file.name}: ${formatError(error)}`);
      }
    }
  } finally {
    state.processing = false;
    elements.engineStatus.textContent = "Движок готов · файлы остаются в браузере";
    state.result = null;
    renderQuoteList();
    syncControls();
    scheduleSave();
  }
  if (errors.length) showError(errors.join("\n"));
}

async function parseInputFile(supplier, file) {
  const fileName = file.name;
  const extension = fileExtension(fileName);
  if (WORKBOOK_EXTENSIONS.has(extension)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = JSON.parse(parseWorkbookFile(supplier, fileName, bytes));
    return {
      quote: parsed.quote,
      warnings: parsed.warnings,
      kind: extension.toUpperCase(),
    };
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = JSON.parse(parseDocxFile(supplier, fileName, bytes));
    return {
      quote: parsed.quote,
      warnings: parsed.warnings,
      kind: "DOCX",
    };
  }
  if (extension === "pdf") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = JSON.parse(parsePdfQuote(supplier, fileName, bytes));
    return {
      quote: parsed.quote,
      warnings: parsed.parse_warnings,
      kind: "PDF",
      pdf: parsed.pdf,
    };
  }

  const content = await file.text();
  if (fileName.toLowerCase().endsWith(".json")) {
    let input;
    try {
      input = JSON.parse(content);
    } catch {
      throw new Error("Не удалось прочитать JSON: проверьте синтаксис файла");
    }
    if (Array.isArray(input.words) && Number.isFinite(input.width) && Number.isFinite(input.height)) {
      const parsed = JSON.parse(parseDocForgeQuote(supplier, fileName, content));
      return {
        quote: parsed.quote,
        warnings: parsed.parse_warnings,
        kind: "OCR",
        ocr: parsed.ocr,
      };
    }
    if (input.quote?.rows) {
      return { quote: input.quote, warnings: input.warnings || [], kind: "JSON" };
    }
    if (Array.isArray(input.rows)) {
      return {
        quote: {
          supplier: input.supplier || supplier,
          currency: input.currency || "RUB",
          vat_included: input.vat_included ?? true,
          vat_rate: input.vat_rate ?? DEFAULT_VAT_RATE,
          source_file: fileName,
          rows: input.rows,
        },
        warnings: [],
        kind: "JSON",
      };
    }
    throw new Error("JSON должен содержать массив товарных строк либо распознанные слова с координатами");
  }

  const parsed = JSON.parse(parseQuoteFile(supplier, fileName, content));
  return {
    quote: parsed.quote,
    warnings: parsed.warnings,
    kind: parsed.detected_delimiter === "tab" ? "TSV" : "CSV",
  };
}

async function loadDemo() {
  if (!state.ready) return;
  hideError();
  state.entries = [];
  state.approvedMatches.clear();
  for (const demo of demoFiles) {
    const parsed = JSON.parse(parseQuoteFile(demo.supplier, demo.name, demo.content));
    state.entries.push({
      id: state.nextId++,
      fileName: demo.name,
      fileSize: new Blob([demo.content]).size,
      quote: parsed.quote,
      warnings: parsed.warnings,
      kind: parsed.detected_delimiter === "tab" ? "TSV" : "CSV",
    });
  }
  state.result = null;
  renderQuoteList();
  syncControls();
  scheduleSave();
  await runComparison({ scroll: false });
}

function renderQuoteList() {
  elements.quoteList.replaceChildren();
  for (const entry of state.entries) {
    const card = document.createElement("article");
    card.className = "quote-card";

    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = entry.kind;

    const fileInfo = document.createElement("div");
    fileInfo.className = "file-info";
    const fileName = document.createElement("strong");
    fileName.textContent = entry.fileName;
    const fileMeta = document.createElement("span");
    const ocrSuffix = entry.ocr ? ` · DocForge ${entry.ocr.table_count} табл.` : "";
    const pdfSuffix = entry.pdf ? ` · DocForge ${entry.pdf.table_count} табл. / ${entry.pdf.page_count} стр.` : "";
    const positionCount = entry.quote.rows.length;
    fileMeta.textContent = `${positionCount} ${pluralRu(positionCount, "позиция", "позиции", "позиций")} · ${formatBytes(entry.fileSize)}${ocrSuffix}${pdfSuffix}`;
    fileInfo.append(fileName, fileMeta);

    const supplierField = document.createElement("div");
    supplierField.className = "supplier-field";
    const supplierLabel = document.createElement("label");
    supplierLabel.textContent = "Поставщик";
    const supplierInput = document.createElement("input");
    supplierInput.id = `supplier-${entry.id}`;
    supplierInput.value = entry.quote.supplier;
    supplierInput.setAttribute("aria-label", `Поставщик для ${entry.fileName}`);
    supplierLabel.htmlFor = supplierInput.id;
    supplierInput.addEventListener("input", (event) => {
      entry.quote.supplier = event.target.value;
      state.result = null;
      syncControls();
      scheduleSave();
    });
    supplierField.append(supplierLabel, supplierInput);

    const vatField = document.createElement("div");
    vatField.className = "vat-field";
    const vatLabel = document.createElement("label");
    vatLabel.className = "vat-toggle";
    const vatCheckbox = document.createElement("input");
    vatCheckbox.type = "checkbox";
    vatCheckbox.checked = entry.quote.vat_included;
    vatCheckbox.setAttribute("aria-label", `Цена ${entry.fileName} уже включает НДС`);
    const vatRateLabel = document.createElement("label");
    vatRateLabel.className = "vat-rate-field";
    const vatRateCaption = document.createElement("span");
    vatRateCaption.textContent = "Ставка НДС";
    const vatRateSelect = document.createElement("select");
    vatRateSelect.id = `vat-rate-${entry.id}`;
    vatRateSelect.setAttribute("aria-label", `Ставка НДС для ${entry.fileName}`);
    vatRateLabel.htmlFor = vatRateSelect.id;
    for (const [rate, label] of VAT_RATE_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(rate);
      option.textContent = label;
      vatRateSelect.append(option);
    }
    if (![...VAT_RATE_OPTIONS].some(([rate]) => Math.abs(rate - entry.quote.vat_rate) < Number.EPSILON)) {
      const customOption = document.createElement("option");
      customOption.value = String(entry.quote.vat_rate);
      customOption.textContent = `${formatNumber(entry.quote.vat_rate * 100)}% · из файла`;
      vatRateSelect.append(customOption);
    }
    vatRateSelect.value = String(entry.quote.vat_rate);
    vatRateSelect.disabled = entry.quote.vat_included;
    vatRateSelect.addEventListener("change", (event) => {
      entry.quote.vat_rate = Number(event.target.value);
      state.result = null;
      syncControls();
      scheduleSave();
    });
    vatCheckbox.addEventListener("change", (event) => {
      entry.quote.vat_included = event.target.checked;
      vatRateSelect.disabled = event.target.checked;
      state.result = null;
      syncControls();
      scheduleSave();
    });
    vatLabel.append(vatCheckbox, document.createTextNode("Цена включает НДС"));
    vatRateLabel.append(vatRateCaption, vatRateSelect);
    vatField.append(vatLabel, vatRateLabel);

    const removeButton = document.createElement("button");
    removeButton.className = "icon-button";
    removeButton.type = "button";
    removeButton.setAttribute("aria-label", `Удалить ${entry.fileName}`);
    removeButton.textContent = "×";
    removeButton.addEventListener("click", () => {
      state.entries = state.entries.filter((candidate) => candidate.id !== entry.id);
      state.result = null;
      renderQuoteList();
      syncControls();
      scheduleSave();
    });

    card.append(icon, fileInfo, supplierField, vatField, removeButton);
    const warnings = [...entry.warnings];
    if (entry.ocr?.needs_review) warnings.push("DocForge рекомендует проверить распознанную таблицу");
    if (warnings.length) {
      const warning = document.createElement("div");
      warning.className = "quote-warning";
      warning.textContent = warnings.join(" · ");
      card.append(warning);
    }
    elements.quoteList.append(card);
  }
}

async function runComparison(options = {}) {
  const { scroll = true } = options;
  if (!state.ready || state.entries.length < 2) return;
  hideError();
  const supplierInputs = [...elements.quoteList.querySelectorAll(".supplier-field input")];
  const emptySupplierIndex = state.entries.findIndex((entry) => !entry.quote.supplier.trim());
  if (emptySupplierIndex !== -1) {
    showError(
      `Укажите поставщика для файла ${state.entries[emptySupplierIndex].fileName}`,
      [supplierInputs[emptySupplierIndex]],
    );
    return;
  }
  const supplierNames = state.entries.map((entry) => entry.quote.supplier.trim().toLocaleLowerCase("ru-RU"));
  const duplicateIndex = supplierNames.findIndex((name, index) => supplierNames.indexOf(name) !== index);
  if (duplicateIndex !== -1) {
    const duplicateName = supplierNames[duplicateIndex];
    const duplicateInputs = supplierInputs.filter((_, index) => supplierNames[index] === duplicateName);
    showError(
      `Названия поставщиков должны различаться: «${state.entries[duplicateIndex].quote.supplier.trim()}» указано несколько раз`,
      duplicateInputs,
    );
    return;
  }

  const originalLabel = elements.compareButton.textContent;
  elements.compareButton.disabled = true;
  elements.compareButton.textContent = "Сопоставляем позиции…";
  await nextFrame();

  try {
    const request = {
      quotes: state.entries.map((entry) => entry.quote),
      match_threshold: 0.72,
    };
    state.result = JSON.parse(compareQuotes(JSON.stringify(request)));
    applyManualApprovals(state.result);
    renderResults();
    if (scroll) elements.results.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showError(formatError(error));
  } finally {
    elements.compareButton.textContent = originalLabel;
    syncControls();
  }
}

function renderResults() {
  const result = state.result;
  if (!result) {
    elements.results.hidden = true;
    elements.resultStatus.textContent = "";
    return;
  }
  elements.results.hidden = false;

  const currency = result.summary.currency || "RUB";
  const inputRowCount = result.summary.input_row_count;
  const itemCount = result.summary.item_count;
  const summaryCards = [
    ["Предложений", String(result.summary.quote_count), `${inputRowCount} ${pluralRu(inputRowCount, "исходная строка", "исходные строки", "исходных строк")}`, ""],
    ["Сопоставлено позиций", String(result.summary.comparable_item_count), `из ${itemCount} ${pluralRu(itemCount, "группы", "групп", "групп")}`, ""],
    ["Требуют проверки", String(result.summary.needs_review_count), "сомнительные совпадения", ""],
    ["Разброс к дорогим ценам", formatMoney(result.summary.potential_savings, currency), "не гарантированная экономия", "highlight"],
  ];
  elements.summaryGrid.replaceChildren(
    ...summaryCards.map(([label, value, note, className]) => {
      const card = document.createElement("article");
      card.className = `summary-card ${className}`.trim();
      const labelNode = document.createElement("span");
      labelNode.textContent = label;
      const valueNode = document.createElement("strong");
      valueNode.textContent = value;
      const noteNode = document.createElement("small");
      noteNode.textContent = note;
      card.append(labelNode, valueNode, noteNode);
      return card;
    }),
  );

  if (result.warnings.length) {
    elements.resultWarnings.hidden = false;
    elements.resultWarnings.textContent = result.warnings.join(" · ");
  } else {
    elements.resultWarnings.hidden = true;
    elements.resultWarnings.textContent = "";
  }

  const headRow = document.createElement("tr");
  for (const label of ["Позиция", "Кол-во", ...result.suppliers, "Лучшее предложение", "Разброс", "Контроль"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headRow.append(th);
  }
  elements.resultHead.replaceChildren(headRow);
  elements.resultBody.replaceChildren(
    ...result.items.map((item) => renderResultRow(item, result.suppliers, currency, result.items)),
  );
  elements.resultStatus.textContent = `Сравнение готово: ${itemCount} ${pluralRu(itemCount, "позиция", "позиции", "позиций")}. Нужно проверить: ${result.summary.needs_review_count}.`;
}

function renderResultRow(item, suppliers, currency, allItems) {
  const row = document.createElement("tr");

  const itemCell = document.createElement("th");
  itemCell.scope = "row";
  itemCell.className = "item-cell";
  const itemName = document.createElement("strong");
  itemName.textContent = item.canonical_name;
  const sku = document.createElement("small");
  sku.textContent = item.canonical_sku ? `Артикул: ${item.canonical_sku}` : "Без артикула";
  itemCell.append(itemName, sku);
  row.append(itemCell);

  const quantity = document.createElement("td");
  quantity.textContent = `${formatNumber(item.quantity)} ${item.normalized_unit}`;
  row.append(quantity);

  for (const supplier of suppliers) {
    const priceCell = document.createElement("td");
    priceCell.className = "price-cell";
    const offer = item.offers.find((candidate) => candidate.supplier === supplier);
    if (offer) {
      if (offer.is_winner) priceCell.classList.add("winning");
      const price = document.createElement("strong");
      price.textContent = formatMoney(offer.comparable_unit_price, offer.currency || currency);
      const evidence = document.createElement("small");
      const source = offer.source_file || "исходный файл";
      const location = offer.source_page
        ? `стр. ${offer.source_page}, строка ${offer.source_row}`
        : offer.source_sheet?.startsWith("DOCX: ")
          ? `${offer.source_sheet.slice(6)}, строка ${offer.source_row}`
          : offer.source_sheet
            ? `лист «${offer.source_sheet}», строка ${offer.source_row}`
            : `строка ${offer.source_row}`;
      evidence.textContent = `${source}, ${location} · ${Math.round(offer.match_score * 100)}%`;
      priceCell.append(price, evidence);
    } else {
      priceCell.textContent = "—";
    }
    row.append(priceCell);
  }

  const winnerCell = document.createElement("td");
  if (item.winner_supplier) {
    const chip = document.createElement("span");
    chip.className = "winner-chip";
    chip.textContent = item.winner_supplier;
    winnerCell.append(chip);
  } else {
    winnerCell.textContent = "—";
  }
  row.append(winnerCell);

  const spreadCell = document.createElement("td");
  spreadCell.className = "spread-cell";
  if (item.potential_savings > 0) {
    const saving = document.createElement("span");
    saving.className = "saving-value";
    saving.textContent = formatMoney(item.potential_savings, currency);
    const percent = document.createElement("small");
    percent.textContent = item.spread_percent == null ? "" : `${formatNumber(item.spread_percent)}% к максимальной цене`;
    spreadCell.append(saving, percent);
  } else {
    spreadCell.textContent = "—";
  }
  row.append(spreadCell);

  const reviewCell = document.createElement("td");
  reviewCell.className = "review-cell";
  const confidence = document.createElement("span");
  confidence.className = item.needs_review ? "review-chip" : "confidence-chip";
  confidence.textContent = item.manually_approved
    ? "Проверено"
    : item.manually_grouped
      ? "Вручную"
      : item.needs_review
        ? "Проверить"
        : `${Math.round(item.match_confidence * 100)}%`;
  reviewCell.append(confidence);
  if (item.review_reasons.length) {
    const reasons = document.createElement("small");
    reasons.textContent = item.review_reasons.join("; ");
    reviewCell.append(reasons);
  }
  reviewCell.append(renderReviewActions(item, allItems));
  row.append(reviewCell);
  return row;
}

function renderReviewActions(item, allItems) {
  const details = document.createElement("details");
  details.className = "review-actions";
  const summary = document.createElement("summary");
  summary.textContent = "Ручная проверка";
  details.append(summary);

  if (!item.manually_approved) {
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "Подтвердить группу";
    approve.addEventListener("click", () => approveItem(item));
    details.append(approve);
  }

  if (item.offers.length > 1) {
    const splitLabel = document.createElement("label");
    splitLabel.textContent = "Отделить позицию";
    const splitSelect = document.createElement("select");
    for (const [index, offer] of item.offers.entries()) {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${offer.supplier}: ${offer.name}`;
      splitSelect.append(option);
    }
    const splitButton = document.createElement("button");
    splitButton.type = "button";
    splitButton.textContent = "Разъединить";
    splitButton.addEventListener("click", () => void splitOffer(item, Number(splitSelect.value)));
    splitLabel.append(splitSelect, splitButton);
    details.append(splitLabel);
  }

  const suppliers = new Set(item.offers.map((offer) => offer.supplier));
  const mergeTargets = allItems.filter(
    (candidate) => candidate.item_id !== item.item_id
      && candidate.offers.every((offer) => !suppliers.has(offer.supplier)),
  );
  if (mergeTargets.length) {
    const mergeLabel = document.createElement("label");
    mergeLabel.textContent = "Объединить с группой";
    const mergeSelect = document.createElement("select");
    for (const target of mergeTargets) {
      const option = document.createElement("option");
      option.value = String(target.item_id);
      option.textContent = target.canonical_name;
      mergeSelect.append(option);
    }
    const mergeButton = document.createElement("button");
    mergeButton.type = "button";
    mergeButton.textContent = "Объединить";
    mergeButton.addEventListener("click", () => {
      const target = allItems.find((candidate) => candidate.item_id === Number(mergeSelect.value));
      if (target) void mergeItems(item, target);
    });
    mergeLabel.append(mergeSelect, mergeButton);
    details.append(mergeLabel);
  }

  if (item.manually_grouped || item.manually_approved) {
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "reset-review";
    resetButton.textContent = "Сбросить ручное решение";
    resetButton.addEventListener("click", () => void resetManualDecision(item));
    details.append(resetButton);
  }
  return details;
}

function applyManualApprovals(result) {
  const currentSignatures = new Set();
  for (const item of result.items) {
    const signature = itemSignature(item);
    currentSignatures.add(signature);
    item.manually_approved = state.approvedMatches.has(signature);
    if (item.manually_approved) {
      item.needs_review = false;
      item.review_reasons = [];
    }
  }
  state.approvedMatches = new Set(
    [...state.approvedMatches].filter((signature) => currentSignatures.has(signature)),
  );
  result.summary.needs_review_count = result.items.filter((item) => item.needs_review).length;
}

function itemSignature(item) {
  return item.offers
    .map((offer) => [
      offer.source_file,
      offer.source_sheet || "",
      offer.source_page || "",
      offer.source_row,
    ].join(":"))
    .sort()
    .join("|");
}

function approveItem(item) {
  state.approvedMatches.add(itemSignature(item));
  item.manually_approved = true;
  item.needs_review = false;
  item.review_reasons = [];
  state.result.summary.needs_review_count = state.result.items.filter((candidate) => candidate.needs_review).length;
  renderResults();
  scheduleSave();
}

async function splitOffer(item, offerIndex) {
  const offer = item.offers[offerIndex];
  const row = findSourceRow(offer);
  if (!row) {
    showError("Не удалось найти исходную строку для ручного разъединения");
    return;
  }
  state.approvedMatches.delete(itemSignature(item));
  row.manual_group = `split-${manualId()}`;
  await runComparison({ scroll: false });
  scheduleSave();
}

async function mergeItems(item, target) {
  const rows = [...item.offers, ...target.offers].map(findSourceRow);
  if (rows.some((row) => !row)) {
    showError("Не удалось найти все исходные строки для ручного объединения");
    return;
  }
  state.approvedMatches.delete(itemSignature(item));
  state.approvedMatches.delete(itemSignature(target));
  const group = `merge-${manualId()}`;
  for (const row of rows) row.manual_group = group;
  await runComparison({ scroll: false });
  scheduleSave();
}

async function resetManualDecision(item) {
  state.approvedMatches.delete(itemSignature(item));
  for (const offer of item.offers) {
    const row = findSourceRow(offer);
    if (row) row.manual_group = null;
  }
  await runComparison({ scroll: false });
  scheduleSave();
}

function findSourceRow(offer) {
  const entry = state.entries.find(
    (candidate) => candidate.quote.source_file === offer.source_file
      && candidate.quote.supplier === offer.supplier,
  );
  return entry?.quote.rows.find(
    (row) => row.source_row === offer.source_row
      && (row.source_page ?? null) === (offer.source_page ?? null)
      && (row.source_sheet ?? null) === (offer.source_sheet ?? null),
  );
}

function manualId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function exportCsv() {
  if (!state.result) return;
  try {
    const csv = exportComparisonCsv(JSON.stringify(state.result));
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `sravnikp-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } catch (error) {
    showError(formatError(error));
  }
}

function clearWorkspace() {
  if (state.processing) return;
  if (!window.confirm("Удалить все добавленные предложения и ручные решения с этого устройства?")) return;
  state.entries = [];
  state.result = null;
  state.approvedMatches.clear();
  renderQuoteList();
  renderResults();
  hideError();
  syncControls();
  void clearSavedWorkspace();
}

function syncControls() {
  const readyToCompare = state.ready && !state.processing && state.entries.length >= 2;
  elements.compareButton.disabled = !readyToCompare;
  elements.fileInput.disabled = !state.ready || state.processing;
  elements.clearButton.hidden = state.entries.length === 0;
  elements.clearButton.disabled = state.processing;
  elements.dropZone.hidden = state.entries.length >= MAX_FILES;
  elements.dropZone.setAttribute("aria-busy", String(state.processing));
  if (!state.result) elements.results.hidden = true;
}

function fileExtension(fileName) {
  return fileName.split(".").pop()?.toLocaleLowerCase("ru-RU") || "";
}

function validateParsedEntry(entry) {
  const rows = entry?.quote?.rows;
  if (typeof entry?.quote?.supplier !== "string") {
    throw new Error("название поставщика должно быть текстом");
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("не найдено ни одной товарной позиции");
  }
  if (rows.length > MAX_ROWS_PER_FILE) {
    throw new Error(`в файле больше ${MAX_ROWS_PER_FILE.toLocaleString("ru-RU")} позиций; разделите его`);
  }
  const invalidRow = rows.find(
    (row) => typeof row?.name !== "string"
      || !row.name.trim()
      || typeof row.unit_price !== "number"
      || !Number.isFinite(row.unit_price),
  );
  if (invalidRow) {
    throw new Error("позиции должны содержать текстовое наименование и числовую цену");
  }
  const vatRate = entry.quote.vat_rate ?? DEFAULT_VAT_RATE;
  if (!isValidVatRate(vatRate)) {
    throw new Error("ставка НДС должна быть числом от 0 до 100 процентов");
  }
  entry.quote.vat_rate = Number(vatRate);
  if (typeof entry.quote.vat_included !== "boolean") entry.quote.vat_included = true;
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECT_STORE)) {
        database.createObjectStore(PROJECT_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB недоступна")));
    request.addEventListener("blocked", () => reject(new Error("IndexedDB заблокирована другой вкладкой")));
  });
  return databasePromise;
}

function databaseRequest(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error || new Error("Ошибка локального хранилища")));
  });
}

async function restoreWorkspace() {
  try {
    const database = await openDatabase();
    const transaction = database.transaction(PROJECT_STORE, "readonly");
    const record = await databaseRequest(transaction.objectStore(PROJECT_STORE).get(PROJECT_KEY));
    const entries = Array.isArray(record?.entries)
      ? record.entries
        .filter(isRestorableEntry)
        .slice(0, MAX_FILES)
        .map((entry) => {
          entry.quote.vat_rate = Number(entry.quote.vat_rate ?? DEFAULT_VAT_RATE);
          if (typeof entry.quote.vat_included !== "boolean") entry.quote.vat_included = true;
          return entry;
        })
      : [];
    if (entries.length === 0) {
      elements.storageStatus.textContent = "Автосохранение локально";
      return;
    }
    state.entries = entries;
    state.approvedMatches = new Set(
      Array.isArray(record.approvedMatches)
        ? record.approvedMatches.filter((value) => typeof value === "string").slice(0, MAX_ROWS_PER_FILE)
        : [],
    );
    state.nextId = Math.max(Number(record.nextId) || 1, ...entries.map((entry) => Number(entry.id) + 1));
    state.result = null;
    renderQuoteList();
    const savedAt = record.savedAt ? new Date(record.savedAt) : null;
    const time = savedAt && !Number.isNaN(savedAt.getTime())
      ? savedAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
      : "ранее";
    elements.storageStatus.textContent = `Восстановлено ${entries.length} КП · ${time}`;
  } catch (error) {
    elements.storageStatus.textContent = "Автосохранение недоступно";
    console.warn("Не удалось восстановить локальный проект", error);
  }
}

function isRestorableEntry(entry) {
  return Boolean(
    entry
      && Number.isInteger(entry.id)
      && typeof entry.fileName === "string"
      && typeof entry.kind === "string"
      && Array.isArray(entry.warnings)
      && typeof entry.quote?.supplier === "string"
      && isValidVatRate(entry.quote?.vat_rate ?? DEFAULT_VAT_RATE)
      && Array.isArray(entry.quote?.rows)
      && entry.quote.rows.length > 0
      && entry.quote.rows.length <= MAX_ROWS_PER_FILE
      && entry.quote.rows.every((row) => typeof row?.name === "string"
        && typeof row.unit_price === "number"
        && Number.isFinite(row.unit_price)),
  );
}

function isValidVatRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1;
}

function scheduleSave() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => void saveWorkspace(), 300);
}

async function saveWorkspace() {
  if (state.entries.length === 0) {
    await clearSavedWorkspace();
    return;
  }
  try {
    const database = await openDatabase();
    const transaction = database.transaction(PROJECT_STORE, "readwrite");
    const entries = state.entries.map(persistableEntry);
    await databaseRequest(transaction.objectStore(PROJECT_STORE).put({
      version: 1,
      savedAt: new Date().toISOString(),
      nextId: state.nextId,
      approvedMatches: [...state.approvedMatches],
      entries,
    }, PROJECT_KEY));
    elements.storageStatus.textContent = "Проект сохранён · локально";
  } catch (error) {
    elements.storageStatus.textContent = "Автосохранение недоступно";
    console.warn("Не удалось сохранить локальный проект", error);
  }
}

function persistableEntry(entry) {
  const persisted = {
    id: entry.id,
    fileName: entry.fileName,
    fileSize: entry.fileSize,
    quote: entry.quote,
    warnings: entry.warnings,
    kind: entry.kind,
  };
  if (entry.ocr) {
    persisted.ocr = {
      engine: entry.ocr.engine,
      table_count: entry.ocr.table_count,
      needs_review: entry.ocr.needs_review,
    };
  }
  if (entry.pdf) {
    persisted.pdf = {
      engine: entry.pdf.engine,
      page_count: entry.pdf.page_count,
      text_span_count: entry.pdf.text_span_count,
      table_count: entry.pdf.table_count,
      needs_review: entry.pdf.needs_review,
    };
  }
  return persisted;
}

async function clearSavedWorkspace() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = null;
  try {
    const database = await openDatabase();
    const transaction = database.transaction(PROJECT_STORE, "readwrite");
    await databaseRequest(transaction.objectStore(PROJECT_STORE).delete(PROJECT_KEY));
    elements.storageStatus.textContent = "Проект очищен · локально";
  } catch (error) {
    elements.storageStatus.textContent = "Автосохранение недоступно";
    console.warn("Не удалось очистить локальный проект", error);
  }
}

function supplierFromFilename(fileName) {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
  const cleaned = base
    .replace(
      /(^|[^\p{L}\p{N}])(кп|offer|price|прайс|коммерческое предложение)(?=$|[^\p{L}\p{N}])/giu,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || `Поставщик ${state.entries.length + 1}`;
}

function formatMoney(value, currency = "RUB") {
  if (!Number.isFinite(Number(value))) return "—";
  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return `${formatNumber(value)} ${currency}`;
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Number(value));
}

function formatBytes(bytes) {
  if (!bytes) return "демо";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function pluralRu(value, one, few, many) {
  const absolute = Math.abs(Number(value)) % 100;
  const last = absolute % 10;
  if (absolute > 10 && absolute < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function formatError(error) {
  const text = error?.message || String(error);
  const cleaned = text.replace(/^(Error|TypeError|SyntaxError):\s*/i, "").trim();
  if (/^(Не удалось прочитать JSON|Некорректный OCR JSON)\b/iu.test(cleaned)
    || /JSON\.parse|Unexpected token|unexpected character|at position \d+/i.test(cleaned)) {
    return "Не удалось прочитать JSON: проверьте синтаксис файла";
  }
  if (!/\p{Script=Cyrillic}/u.test(cleaned)) {
    return "Не удалось обработать файл: проверьте его формат и целостность";
  }
  return cleaned;
}

function showError(message, invalidFields = []) {
  hideError();
  elements.inlineError.hidden = false;
  elements.inlineError.textContent = message;
  for (const field of invalidFields.filter(Boolean)) {
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-describedby", elements.inlineError.id);
  }
  invalidFields.find(Boolean)?.focus();
}

function hideError() {
  for (const field of elements.quoteList.querySelectorAll('[aria-describedby="inline-error"]')) {
    field.removeAttribute("aria-invalid");
    field.removeAttribute("aria-describedby");
  }
  elements.inlineError.hidden = true;
  elements.inlineError.textContent = "";
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
