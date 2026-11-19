(() => {
  'use strict';

  const codec = window.JhlNrbfCodec;
  const catalog = window.JhlCatalog;
  const core = window.JhlEditorCore;
  const native = window.__JHL_NATIVE__;
  const bridge = window.__JHL_BRIDGE__;
  const runtime = native ? 'native' : bridge?.token ? 'server' : 'offline';
  const $ = id => document.getElementById(id);
  const text = value => value == null ? '' : String(value);
  const clone = value => structuredClone(value);
  let doc, state, baseline, source, studentIndex = 0, categoryIndex = 0;
  let confirmAction, busy = false, toastTimer;

  function el(tag, label) {
    const node = document.createElement(tag);
    if (label != null) node.textContent = label;
    return node;
  }

  function add(parent, ...nodes) {
    nodes.forEach(node => parent.appendChild(node));
    return parent;
  }

  function button(label, action) {
    const node = el('button', label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
  }

  const run = (action, failure) => async () => {
    if (busy) return;
    busy = true;
    try { await action(); }
    catch { toast(failure); }
    finally { busy = false; }
  };

  function field(parent, object, key, label, numeric = false) {
    const input = el('input');
    input.dataset.key = key;
    input.type = numeric ? 'number' : typeof object[key] === 'boolean' ? 'checkbox' : 'text';
    if (numeric) input.step = 'any';
    input.value = object[key] == null ? '' : text(object[key]);
    if (input.type === 'checkbox') input.checked = Boolean(object[key]);
    input.addEventListener('input', () => {
      if (numeric && (input.value === '' || !Number.isFinite(input.valueAsNumber))) {
        input.setCustomValidity('숫자를 입력하세요');
        return;
      }
      input.setCustomValidity('');
      object[key] = numeric ? input.valueAsNumber : input.type === 'checkbox' ? input.checked : input.value;
      refresh();
    });
    add(parent, add(el('label'), el('span', label), input));
  }

  function table(parent, headings, rows, activate) {
    const body = el('tbody');
    rows.forEach((cells, index) => {
      const row = el('tr');
      cells.forEach((cell, column) => {
        const td = el('td');
        if (activate && column === 0) add(td, button(text(cell), () => activate(index)));
        else if (cell instanceof Node) add(td, cell);
        else td.textContent = text(cell);
        add(row, td);
      });
      add(body, row);
    });
    add(parent, add(el('table'), add(el('thead'), add(el('tr'), ...headings.map(label => el('th', label)))), body));
  }

  const sectionIds = [
    'save-summary', 'currency-fields', 'preset-controls', 'combat-calculator',
    'student-list', 'student-stats', 'student-traits', 'student-titles',
    'martial-skills', 'cultivation-techniques', 'internal-energy', 'weapon-list',
    'armor-list', 'warehouse-list', 'building-list', 'diplomacy-list',
    'market-prices', 'summary-slots'
  ];
  const schoolOf = () => state?.school ?? state?.schoolData ?? state?.summary ?? state;
  const studentsOf = () => state?.students ?? state?.studentList ?? schoolOf()?.students ?? [];
  const studentOf = () => studentsOf()[studentIndex];
  const warehouseOf = () => state?.warehouse ?? state?.storage ?? state;
  const worldOf = () => state?.world ?? state;
  const schoolFields = [
    ['name', '문파 이름'], ['schoolLevel', '문파 단계', true], ['money', '은전', true],
    ['jhMoney', '강호 자금', true], ['food', '식량', true], ['exp', '경험치', true],
    ['goodEvilValue', '선악 수치', true], ['dateTime', '날짜'],
    ['jhFightFinishedLevel', '강호 전투 완료 단계', true]
  ];
  const stats = [['str', '힘'], ['dex', '민첩'], ['vit', '체력'], ['int', '지능'], ['wil', '의지'], ['spr', '정신']];
  const statFields = student => {
    const values = student.attr ?? student.stats ?? student;
    const keys = Object.keys(values).filter(key => /^max[A-Z][a-zA-Z]*$/.test(key) &&
      Object.hasOwn(values, key[3].toLowerCase() + key.slice(4)));
    return (keys.length ? keys.map(key => key[3].toLowerCase() + key.slice(4)) : stats.map(([key]) => key))
      .map(key => [key, stats.find(([known]) => known === key)?.[1] ??
        ({ agi: '민첩', con: '체질', sta: '지구력', wis: '지혜', spi: '정신', luk: '운' })[key] ?? '능력치']);
  };

  function applyPresetById(id) {
    if (!state) throw Error('저장 파일을 먼저 여세요');
    if (typeof core.applyPreset === 'function') state = core.applyPreset(state, id) ?? state;
    else {
      const preset = (core.PRESETS ?? []).find(p => p.id === id);
      if (!preset) throw Error('알 수 없는 기본 설정입니다');
      if (id === 'wealth') {
        ['money', 'jhMoney', 'food'].forEach(k => { schoolOf()[k] = Math.max(Number(schoolOf()[k]) || 0, 1000000); });
      } else if (id === 'school_max') {
        schoolOf().schoolLevel = Math.max(Number(schoolOf().schoolLevel) || 0, 10);
        schoolOf().exp = Math.max(Number(schoolOf().exp) || 0, 1000000);
      } else if (id === 'disciples_god') {
        studentsOf().forEach(s => {
          const attr = s.attr ??= {};
          ['str', 'agi', 'vit', 'int', 'wil', 'spr'].forEach(k => { attr[k] = Math.max(Number(attr[k]) || 0, 100); });
          s.loyalty = 100;
        });
      } else if (id === 'disciples_heal') {
        studentsOf().forEach(s => {
          s.ill = 0;
          s.hasTreatedIll = true;
        });
      }
    }
    render();
    return state;
  }

  function entries(collection) {
    return Array.isArray(collection) ? collection : Object.entries(collection ?? {}).map(([id, value]) =>
      value && typeof value === 'object' ? { id, ...value } : { id, name: value });
  }

  const idOf = value => value && typeof value === 'object'
    ? value.id ?? value.itemId ?? value.skillId ?? value.kidneyId ?? value.schoolId ?? value.propId ?? value.dataId
    : value;
  const nameOf = value => value && typeof value === 'object' ? value.name ?? value.title ?? value.label : undefined;

  function labelOf(value, collection) {
    return nameOf(value) ?? nameOf(entries(collection).find(entry => text(idOf(entry)) === text(idOf(value)))) ??
      (idOf(value) == null ? '이름 없음' : text(idOf(value)));
  }

  function search(parent, collection, select) {
    const input = el('input');
    const results = el('div');
    input.type = 'search';
    input.placeholder = '이름 또는 번호 검색';
    input.setAttribute('aria-label', input.placeholder);
    const options = entries(collection);
    const update = () => {
      const query = input.value.trim().toLowerCase();
      results.replaceChildren();
      if (!query) return;
      const matches = options.filter(option =>
        `${labelOf(option)} ${text(idOf(option))}`.toLowerCase().includes(query)).slice(0, 30);
      if (!matches.length) add(results, el('p', '검색 결과가 없습니다'));
      matches.forEach(option => add(results, button(`${labelOf(option)} 추가`, () => select(option))));
    };
    input.addEventListener('input', update);
    add(parent, input, results);
  }

  function listEditor(parent, owner, key, collection, countKey, itemKey, countLabel = '수량') {
    const list = Array.isArray(owner[key]) ? owner[key] : [];
    const rows = el('div');
    const draw = () => {
      rows.replaceChildren();
      if (!list.length) add(rows, el('p', '항목이 없습니다'));
      list.forEach((item, index) => {
        const row = add(el('div'), el('span', labelOf(item, collection)));
        if (countKey && item && typeof item === 'object') field(row, item, countKey, countLabel, true);
        add(row, button('제거', () => { list.splice(index, 1); draw(); refresh(); }));
        add(rows, row);
      });
    };
    add(parent, rows);
    draw();
    if (collection) search(parent, collection, option => {
      const id = idOf(option);
      if (id == null || list.some(item => text(idOf(item)) === text(id))) {
        toast('이미 있거나 번호가 없는 항목입니다');
        return;
      }
      const sample = list.find(item => item && typeof item === 'object');
      const keyName = sample && ['id', 'itemId', 'skillId', 'kidneyId', 'propId', 'dataId']
        .find(candidate => Object.hasOwn(sample, candidate));
      const item = countKey || sample ? { [keyName ?? itemKey ?? 'id']: id } : id;
      if (countKey) item[countKey] = 1;
      owner[key] = list;
      list.push(item);
      draw();
      refresh();
    });
  }

  const categories = [
    ['props', '물품'], ['originMaterials', '원재료'], ['prepareMaterials', '가공 재료'],
    ['hiddenWeapons', '암기'], ['skills', '무공서'], ['futures', '선물 상품']
  ];

  function renderWarehouse() {
    const warehouse = warehouseOf();
    const weapons = $('weapon-list');
    const armors = $('armor-list');
    for (const [parent, key, prop, label] of [
      [weapons, 'weapons', 'upgradeCount', '강화 횟수'],
      [armors, 'armors', 'durability', '내구도']
    ]) {
      const rows = entries(warehouse[key]).map(item => {
        const editor = el('div');
        field(editor, item, prop, label, true);
        return [labelOf(item, catalog.items), editor];
      });
      table(parent, ['이름', label], rows);
    }
    const node = $('warehouse-list');
    const select = el('select');
    select.setAttribute('aria-label', '창고 분류');
    categories.forEach(([, label], index) => {
      const option = el('option', label);
      option.value = index;
      add(select, option);
    });
    select.selectedIndex = categoryIndex;
    const contents = el('div');
    const draw = () => {
      contents.replaceChildren();
      const [key] = categories[categoryIndex];
      listEditor(contents, warehouse, key, catalog.items, key === 'futures' ? null : 'count', key === 'skills' ? 'skillId' : 'itemId');
    };
    select.addEventListener('change', () => { categoryIndex = select.selectedIndex; draw(); });
    add(node, select, contents);
    draw();
  }

  function renderWorld() {
    const world = worldOf();
    for (const [container, key, prop, label, lookup] of [
      ['building-list', 'buildings', 'level', '단계', catalog.buildings],
      ['diplomacy-list', 'diplomacy', 'friendValue', '우호도', catalog.schools],
      ['market-prices', 'futuresPrices', 'monthPriceRate', '시세율', catalog.items]
    ]) {
      const collection = world[key];
      const rows = Object.entries(collection ?? {}).map(([id, value]) => {
        const record = value && typeof value === 'object';
        const sampleValue = record ? value : collection;
        const actualProp = record ? (prop in sampleValue ? prop : Object.keys(sampleValue)[0]) : id;
        const editor = el('div');
        field(editor, sampleValue, actualProp, label, typeof sampleValue[actualProp] === 'number');
        return [labelOf(record && (nameOf(value) || idOf(value) != null) ? value : id, lookup), editor];
      });
      table($(container), ['이름', label], rows);
    }
    const slots = state.summarySlots ?? state.storeData?.summarySlots ?? state.StoreData?.summarySlots ?? world.summarySlots;
    if (!slots || (Array.isArray(slots) && slots.length === 0)) {
      add($('summary-slots'), el('p', '요약 슬롯이 없습니다'));
      return;
    }
    Object.entries(slots).forEach(([key, value], index) => {
      const row = el('fieldset');
      add(row, el('legend', `요약 슬롯 ${index + 1}`));
      if (value && typeof value === 'object') {
        schoolFields.forEach(([prop, label, number]) => {
          if (Object.hasOwn(value, prop)) field(row, value, prop, label, number);
        });
        Object.keys(value).filter(prop => !schoolFields.some(([known]) => known === prop) &&
          ['number', 'string', 'boolean'].includes(typeof value[prop])).forEach((prop, position) =>
          field(row, value, prop, `항목 ${position + 1}`, typeof value[prop] === 'number'));
      } else field(row, slots, key, '값', typeof value === 'number');
      add($('summary-slots'), row);
    });
  }

  function combat() {
    const node = $('combat-calculator');
    const student = studentOf();
    node.replaceChildren();
    if (!student) return;
    const stats = typeof core.computeCombatStats === 'function' ? core.computeCombatStats(student) : { maxHp: 0, atk: 0, dzMax: 0, dispatchPower: 0 };
    add(node, el('p', `최대 체력 ${stats.maxHp} · 공격력 ${stats.atk} · 단전 상한 ${stats.dzMax} · 파견 전투력 ${stats.dispatchPower}`));
  }

  function render() {
    sectionIds.forEach(id => $(id).replaceChildren());
    if (!state) return refresh();
    const school = schoolOf();
    const metaOwner = state.meta ?? school;
    if (state.meta?.kind !== 'StoreData') {
      schoolFields.forEach(([key, label, number]) => {
        const owner = (key === 'dateTime' || key === 'jhFightFinishedLevel') && Object.hasOwn(metaOwner, key) ? metaOwner : school;
        const prop = key === 'name' && !Object.hasOwn(owner, 'name') && Object.hasOwn(owner, 'schoolName') ? 'schoolName' : key;
        field($(['money', 'jhMoney', 'food', 'exp'].includes(key) ? 'currency-fields' : 'save-summary'), owner, prop, label, number);
      });
    }
    
    const presetNode = $('preset-controls');
    const presetsList = core.PRESETS ?? [
      { id: 'wealth', name: '재산 확충' }, { id: 'school_max', name: '문파 성장' },
      { id: 'disciples_god', name: '제자 강화' }, { id: 'disciples_heal', name: '제자 치료' },
      { id: 'supply_pack', name: '보급품 확충' }, { id: 'diplomacy_max', name: '외교 개선' }
    ];
    presetsList.forEach(p => {
      const id = typeof p === 'string' ? p : p.id;
      const label = typeof p === 'string' ? p : (p.name ?? p.id);
      const btn = button(label, () => applyPresetById(id));
      btn.dataset.preset = id;
      add(presetNode, btn);
    });

    const students = studentsOf();
    table($('student-list'), ['제자 이름', '단계'], students.map(student => [student.name || '이름 없음', student.levelId ?? student.level]),
      index => { studentIndex = index; render(); });
    const student = studentOf();
    if (student) {
      const statsNode = $('student-stats');
      field(statsNode, student, 'name', '제자 이름');
      for (const [key, label] of [
        ['levelId', '단계'], ['aptitudeLevel', '자질 단계'], ['aptitudeValue', '자질 수치'],
        ['loyalty', '충성도'], ['happyValue', '행복도']
      ]) {
        if (Object.hasOwn(student, key)) field(statsNode, student, key, label, true);
      }
      add(statsNode, button('질병 치료', () => { cure(student); refresh(); toast('질병을 치료했습니다'); }));
      const values = student.attr ?? student.stats ?? student;
      statFields(student).forEach(([key, label]) => {
        field(statsNode, values, key, label, true);
        field(statsNode, values, `max${key[0].toUpperCase()}${key.slice(1)}`, `최대 ${label}`, true);
      });
      const traitKey = ['kidneys', 'kidneyIds', 'kidneyList', 'traits'].find(key => Array.isArray(student[key])) ?? 'kidneys';
      listEditor($('student-traits'), student, traitKey, catalog.kidneys, null, 'kidneyId');
      for (const title of entries(student.titles ?? student.titleIds)) add($('student-titles'), el('p', labelOf(title, catalog.titles)));
      
      const skillKey = 'learnedSkills';
      const sampleSkill = (student[skillKey] ?? [])[0];
      const skillCountKey = sampleSkill && typeof sampleSkill === 'object' && ('learnLevel' in sampleSkill ? 'learnLevel' : 'level');
      listEditor($('martial-skills'), student, skillKey, catalog.skills, skillCountKey, 'skillId', '단계');

      const bookOwner = Object.hasOwn(student, 'storageBooks') ? student : warehouseOf();
      listEditor($('cultivation-techniques'), bookOwner, 'storageBooks', catalog.skills, null, 'skillId');
      for (const [key, label] of [['inPowerSkillIds', '내공 무공'], ['outPowerSkillIds', '외공 무공']]) {
        const group = add(el('fieldset'), el('legend', label));
        add($('internal-energy'), group);
        listEditor(group, student, key, catalog.skills, null, 'skillId');
      }
    }
    renderWarehouse();
    renderWorld();
    refresh();
  }

  function cure(student) {
    student.ill = typeof student.ill === 'number' ? 0 : false;
    student.hasTreatedIll = true;
  }

  const labels = Object.fromEntries([...schoolFields, ...stats, ...categories, [
    'school', '문파'
  ], ['schoolName', '문파 이름'], ['students', '제자'], ['studentList', '제자'], ['stats', '능력치'],
  ['warehouse', '창고'], ['world', '강호'], ['levelId', '단계'], ['aptitudeLevel', '자질 단계'],
  ['aptitudeValue', '자질 수치'], ['loyalty', '충성도'], ['happyValue', '행복도'], ['ill', '질병'],
  ['kidneys', '특성'], ['kidneyIds', '특성'], ['learnedSkills', '배운 무공'], ['storageBooks', '보관 무공서'],
  ['inPowerSkillIds', '내공 무공'], ['outPowerSkillIds', '외공 무공'], ['storageWeaponList', '무기'],
  ['storageArmorGameDataList', '방어구'], ['upgradeCount', '강화 횟수'], ['durability', '내구도'],
  ['buildings', '건물'], ['diplomacy', '외교'], ['friend', '우호도'], ['futuresPrices', '시세'],
  ['summarySlots', '요약 슬롯'], ['rate', '시세율'], ['count', '수량'], ['id', '번호'], ['skillId', '무공 번호'],
  ['itemId', '물품 번호']]);

  function differences(before, after, path = [], rows = []) {
    if (Object.is(before, after)) return rows;
    const group = value => Array.isArray(value) || (value && Object.getPrototypeOf(value) === Object.prototype);
    if (group(before) && group(after) && Array.isArray(before) === Array.isArray(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const label = Array.isArray(after) ? `항목 ${Number(key) + 1}` :
          Object.hasOwn(labels, key) ? labels[key] : `항목 ${key}`;
        differences(before[key], after[key], [...path, label], rows);
      }
    } else rows.push([path.join(' / '), before, after]);
    return rows;
  }

  function display(value) {
    if (value == null) return '없음';
    if (typeof value === 'boolean') return value ? '예' : '아니요';
    if (typeof value === 'object') return nameOf(value) ?? idOf(value) ?? '항목';
    return text(value);
  }

  function validate() {
    const errors = [];
    if (!state) return errors;
    const school = schoolOf();
    const name = school.name ?? school.schoolName;
    if (typeof name === 'string' && !name.trim()) errors.push('문파 이름을 입력하세요');
    for (const [key, label, numeric] of schoolFields) {
      if (numeric && school[key] != null && !Number.isFinite(Number(school[key]))) errors.push(`${label}에 숫자를 입력하세요`);
    }
    if (sectionIds.some(id => $(id).querySelector('input:invalid'))) errors.push('숫자 입력을 확인하세요');
    if (typeof core.validateState === 'function') {
      try {
        const result = core.validateState(state, doc);
        const issues = Array.isArray(result) ? result : result?.errors ?? [];
        if (issues.length || result === false || result?.valid === false || result?.ok === false) {
          errors.push('저장 데이터 검증에서 오류를 찾았습니다');
        }
      } catch { errors.push('저장 데이터 검증에 실패했습니다'); }
    }
    return errors;
  }

  function refresh() {
    combat();
    const body = $('diff-rows');
    const results = $('validation-results');
    if (body) body.replaceChildren();
    if (results) results.replaceChildren();
    const btnValidate = $('btn-validate');
    const btnSave = $('btn-save');
    if (btnValidate) btnValidate.disabled = !state;
    if (btnSave) btnSave.disabled = !state;
    if (!state) return;
    differences(baseline, state).forEach(([path, before, after]) => {
      if (body) add(body, add(el('tr'), el('td', path), el('td', display(before)), el('td', display(after))));
    });
    const errors = validate();
    if (results) (errors.length ? errors : ['검증을 통과했습니다']).forEach(message => add(results, el('p', message)));
  }

  function loadBytes(bytes, metadata = {}) {
    const buffer = ArrayBuffer.isView(bytes)
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
    const parsed = codec.parseNrbf(buffer);
    const next = core.readState(parsed);
    const original = clone(next);
    doc = parsed;
    state = next;
    baseline = original;
    source = { ...metadata, buffer };
    studentIndex = categoryIndex = 0;
    render();
    return state;
  }

  function exportBytes() {
    if (!doc || !state) throw Error('저장 파일을 먼저 여세요');
    const copy = codec.parseNrbf(source.buffer.slice(0));
    core.applyState(copy, state);
    return codec.serializeNrbf(copy);
  }

  const badge = $('runtime-badge');
  if (badge) {
    badge.dataset.runtime = runtime;
    badge.textContent = { native: '네이티브 연결됨', server: '서버 연결됨', offline: '브라우저 오프라인' }[runtime];
  }
  const btnDiscover = $('btn-discover');
  const btnBackups = $('btn-backups');
  if (btnDiscover) btnDiscover.hidden = runtime === 'offline';
  if (btnBackups) btnBackups.hidden = runtime === 'offline';

  function decode(encoded) {
    return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  }

  function encode(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    for (let offset = 0; offset < data.length; offset += 8192) {
      binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }

  async function request(endpoint, payload) {
    const headers = { 'X-Jhl-Token': bridge.token };
    const options = { headers, cache: 'no-store' };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.method = 'POST';
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(`/api/${endpoint}`, options);
    if (!response.ok) throw Error('서버 요청에 실패했습니다');
    return response.json();
  }

  function receive(record, path) {
    if (record == null || record.cancelled) return;
    const encoded = record.bytesBase64 ?? record.base64 ?? record.bytes;
    if (typeof encoded !== 'string' || !record.sha256) throw Error('저장 파일 정보가 올바르지 않습니다');
    loadBytes(decode(encoded), { path: record.path ?? path, sha256: record.sha256, remote: true });
    toast('저장 파일을 열었습니다');
  }

  const dialog = $('confirm-dialog');
  function prompt(title, message, action) {
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-details').replaceChildren();
    $('backup-list').replaceChildren();
    $('backup-list').hidden = true;
    $('btn-confirm-accept').hidden = !action;
    $('btn-confirm-accept').textContent = title.includes('복원') ? '복원' : '저장';
    confirmAction = action;
    if (dialog && !dialog.open) dialog.showModal();
  }

  const btnConfirmCancel = $('btn-confirm-cancel');
  const btnConfirmAccept = $('btn-confirm-accept');
  if (btnConfirmCancel) btnConfirmCancel.addEventListener('click', () => dialog?.close());
  if (dialog) dialog.addEventListener('close', () => { if (!dialog.open) confirmAction = null; });
  if (btnConfirmAccept) btnConfirmAccept.addEventListener('click', run(async () => {
    const action = confirmAction;
    confirmAction = null;
    dialog?.close();
    if (action) await action();
  }, '작업을 완료하지 못했습니다'));

  const fileInput = $('file-input');
  if (fileInput) fileInput.addEventListener('change', run(async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) {
      loadBytes(await file.arrayBuffer(), { filename: file.name });
      toast('저장 파일을 열었습니다');
    }
  }, '저장 파일을 열지 못했습니다'));

  const btnDemo = $('btn-demo');
  if (btnDemo) btnDemo.addEventListener('click', run(async () => {
    loadBytes(await core.createDemoNrbfBytes(), { filename: '예제.sav' });
  }, '예제 파일을 열지 못했습니다'));

  const themeSelect = $('theme-select');
  if (themeSelect) themeSelect.addEventListener('change', event => {
    document.documentElement.dataset.theme = event.target.value;
  });

  const btnValidate = $('btn-validate');
  if (btnValidate) btnValidate.addEventListener('click', () => {
    refresh();
    toast(validate().length ? '검증 결과를 확인하세요' : '검증을 통과했습니다');
  });

  const btnSave = $('btn-save');
  if (btnSave) btnSave.addEventListener('click', () => {
    if (!state || busy) return;
    if (validate().length) {
      refresh();
      toast('검증 오류를 먼저 수정하세요');
      return;
    }
    const rows = differences(baseline, state);
    prompt('저장 확인', `변경 항목 ${rows.length}개를 저장하시겠습니까?`, async () => {
      const bytes = exportBytes();
      if (source.remote) {
        const payload = { path: source.path, baseSha256: source.sha256, bytesBase64: encode(bytes) };
        const result = native ? await native.saveFile(payload) : await request('save', payload);
        if (result?.cancelled) return;
        if (!result?.sha256) throw Error('저장 결과를 확인하지 못했습니다');
        loadBytes(bytes, { ...source, path: result.path ?? source.path, sha256: result.sha256 });
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        const link = el('a');
        link.href = url;
        link.download = `${(source.filename || '저장').replace(/\.sav$/i, '')}.sav`;
        add(document.body, link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      toast('저장했습니다');
    });
    rows.slice(0, 20).forEach(([path, before, after]) =>
      add($('confirm-details'), el('p', `${path} · ${display(before)} → ${display(after)}`)));
  });

  if (btnDiscover) btnDiscover.addEventListener('click', run(async () => {
    if (runtime === 'offline') return;
    const result = native ? await native.discover() : await request('discover');
    if (result?.cancelled) return;
    if (result?.bytesBase64 || result?.bytes || result?.base64) return receive(result);
    const files = Array.isArray(result) ? result : result?.files ?? [];
    const pick = path => run(async () => {
      const record = native ? await native.pickAndLoad(path) : await request('load', { path });
      if (record && !record.cancelled) {
        receive(record, path);
        if (dialog?.open) dialog.close();
      }
    }, '저장 파일을 열지 못했습니다');
    prompt('저장 파일 열기', files.length ? '열 파일을 선택하세요' : '찾은 저장 파일이 없습니다');
    files.forEach(file => {
      const path = typeof file === 'string' ? file : file.path;
      if (path) {
        const b = button(path.split(/[\\/]/).pop(), pick(path));
        add($('confirm-details'), b);
      }
    });
    if (native) add($('confirm-details'), button('파일 찾아보기', pick(undefined)));
  }, '저장 파일을 찾지 못했습니다'));

  if (btnBackups) btnBackups.addEventListener('click', run(async () => {
    if (runtime === 'offline') return;
    const target = { path: source?.path, baseSha256: source?.sha256 };
    const result = native ? await native.listBackups(target) :
      target.path ? await request('backups', target) : await request('backups');
    const backups = Array.isArray(result) ? result : result?.backups ?? [];
    prompt('백업 목록', backups.length ? '복원할 백업을 선택하세요' : '백업이 없습니다');
    $('backup-list').hidden = false;
    backups.forEach(backup => {
      const backupId = typeof backup === 'string' ? backup : backup.id ?? backup.path;
      if (backupId == null) return;
      const name = (typeof backup === 'string' ? backup : backup.name ?? text(backupId)).split(/[\\/]/).pop();
      add($('backup-list'), button(`${name} 복원`, () => {
        prompt('백업 복원 확인', `${name} 백업으로 복원하시겠습니까?`, async () => {
          const payload = { ...target, backupId };
          const restored = native ? await native.restoreBackup(payload) : await request('restore', payload);
          if (restored?.cancelled) return;
          if (!restored?.sha256) throw Error('복원 결과를 확인하지 못했습니다');
          const path = restored.path ?? target.path;
          if (restored.bytesBase64 || restored.bytes || restored.base64) receive(restored, path);
          else if (path) receive(native ? await native.pickAndLoad(path) : await request('load', { path }), path);
          toast('백업을 복원했습니다');
        });
      }));
    });
  }, '백업 목록을 불러오지 못했습니다'));

  window.JhlEditorApp = { getState: () => state, loadBytes, exportBytes, applyPresetById, applyPreset: applyPresetById };
  render();
})();
