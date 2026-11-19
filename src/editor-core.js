(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./nrbf-codec.js'), require('./catalog-data.js'));
  } else {
    root.JhlEditorCore = factory(root.JhlNrbfCodec, root.JhlCatalog);
  }
})(typeof globalThis === 'object' ? globalThis : this, function (Codec, defaultCatalog) {
  'use strict';

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const words = s => s.split(' ');
  const metaFields = words('dateTime curSchoolId genId genWeaponId genArmorId genSkillId jhFightFinishedLevel');
  const schoolFields = words('name schoolLevel money jhMoney food exp maxHistoryExp goodEvilValue standpoint maxStorageCount maxStuStorageCount leaderStudentId');
  const studentFields = words('id name firstName secondName stuJobId sex levelId levelName levelValue goodEvilValue bornAge bornDay ill hasTreatedIll schoolFriendValue happyValue aptitudeLevel aptitudeValue');
  const attrFields = words('loyalty str maxStr agi maxAgi luk maxLuk vit maxVit wis maxWis spr maxSpr gev gec hp');
  const aliases = {
    name: ['name', 'schoolName', 'stuName'],
    id: ['id', 'stuId', 'studentId'],
    attr: ['attr', 'baseAttribute', 'baseAttr'],
    students: ['studentList', 'studentGameDataList', 'stuGameDataList', 'stuList', 'students'],
    summarySlots: ['summarySlots', 'summarySlotList', 'saveSummaryList'],
    kidneys: ['kidneyList'],
    learnedSkills: ['learnedSkills', 'learnedSkillList', 'skillGameDataList'],
    storageBooks: ['storageBooks', 'storageBookList', 'storageSkillBookList'],
    inPowerSkillIds: ['inPowerSkillIds', 'inPowerSkillIdList'],
    outPowerSkillIds: ['outPowerSkillIds', 'outPowerSkillIdList'],
    props: ['storagePropList', 'props'],
    originMaterials: ['storageOriginMaterialList', 'originMaterialList'],
    prepareMaterials: ['storagePrepareMaterialList', 'prepareMaterialList'],
    hiddenWeapons: ['storageHiddenWeaponList', 'hiddenWeaponList'],
    skills: ['storageSkills', 'storageSkillList'],
    futures: ['storageFuturesList', 'storageFutureList'],
    weapons: ['storageWeaponList', 'weaponList'],
    armors: ['storageArmorGameDataList', 'storageArmorList'],
    buildings: ['buildingList'],
    diplomacy: ['interactiveSchoolInfoList'],
    futuresPrices: ['futurePrices', 'futuresPrices']
  };
  const warehouseTypes = {
    props: 'StoragePropData',
    originMaterials: 'StorageOriginMaterialData',
    prepareMaterials: 'StoragePrepareMaterialData',
    hiddenWeapons: 'StorageHiddenWeaponData',
    skills: 'SkillGameData',
    futures: 'StorageFutureData',
    weapons: 'WeaponGameData',
    armors: 'ArmorGameData'
  };
  const listTypes = {
    ...warehouseTypes,
    students: 'StudentGameData',
    summarySlots: 'SaveSummaryData',
    kidneys: 'KidneyGameData',
    learnedSkills: 'SkillGameData',
    storageBooks: 'SkillGameData',
    buildings: 'BuildingGameData',
    diplomacy: 'InteractiveSchoolInfo',
    futuresPrices: 'FuturePrice'
  };
  const studentLists = words('learnedSkills storageBooks inPowerSkillIds outPowerSkillIds');
  const equipment = {
    mainWeapon: ['mainWeaponGameData', 'WeaponGameData', ['upgradeCount', 'maxUpgradeCount']],
    armor: ['armorGameData', 'ArmorGameData', ['durability', 'maxDurability']]
  };
  const className = o => o?.className ?? o?.classInfo?.name ?? o?.metadata?.className ?? o?.metadata?.classInfo?.name ?? o?.name ?? '';
  const rootOf = doc => doc.objects[doc.rootId];
  const namesFor = k => aliases[k] ?? [k];
  const pascal = k => k[0].toUpperCase() + k.slice(1);

  function fieldsOf(doc, o) {
    const metadata = doc.objects[o.metadataId];
    const members = o.memberNames ?? o.classInfo?.memberNames ?? o.metadata?.memberNames ??
      o.metadata?.classInfo?.memberNames ?? metadata?.memberNames ?? metadata?.classInfo?.memberNames;
    if (Array.isArray(members)) return members;
    const fields = o.fields ?? o.members;
    return fields instanceof Map ? [...fields.keys()] : fields && !Array.isArray(fields) ? Object.keys(fields) : [];
  }

  function findField(doc, o, names) {
    if (!o) return undefined;
    const fields = fieldsOf(doc, o);
    for (const k of names) {
      if (fields.includes(k) || Codec.getFieldJs(doc, o, k) !== undefined) return k;
    }
    return undefined;
  }

  function get(doc, o, names) {
    const key = findField(doc, o, names);
    return key === undefined ? undefined : Codec.getFieldJs(doc, o, key);
  }

  function set(doc, o, names, value) {
    const key = findField(doc, o, names);
    if (key !== undefined && value !== undefined) Codec.setFieldJs(doc, o, key, value);
  }

  const resolve = (doc, value) => value && typeof value === 'object' ? Codec.resolveRef(doc, value) : value;
  const field = (doc, o, key) => get(doc, o, namesFor(key));
  const child = (doc, o, key) => resolve(doc, field(doc, o, key));
  const list = (doc, o, key) => child(doc, o, key);
  const items = (doc, o) => o == null ? [] : Codec.listGetItems(doc, o);

  function detectSaveKind(doc) {
    const root = rootOf(doc);
    const name = className(root) || className(root && doc.objects[root.metadataId]);
    const shortName = name.split('.').pop();
    return shortName === 'PlayerGameData' || shortName === 'StoreData' ? shortName : 'Unknown';
  }

  function getTargetSchools(doc) {
    const root = rootOf(doc);
    const ps = child(doc, root, 'playerSchool');
    if (!ps) return [];
    const id = field(doc, ps, 'schoolDataId');
    const mirror = id == null ? undefined : items(doc, list(doc, root, 'schoolGameDataList'))
      .map(value => resolve(doc, value))
      .find(value => value && value !== ps && field(doc, value, 'schoolDataId') === id);
    return mirror ? [ps, mirror] : [ps];
  }

  function createCatalogIndex(catalog = defaultCatalog) {
    return Object.fromEntries(Object.entries(catalog ?? {})
      .filter(([, rows]) => Array.isArray(rows))
      .map(([key, rows]) => [key, new Map(rows.filter(row => row?.id != null).map(row => [row.id, row]))]));
  }

  function readFields(doc, o, keys, nameFor = namesFor) {
    return Object.fromEntries(keys.map(key => [key, get(doc, o, nameFor(key))]));
  }

  function writeFields(doc, o, value, keys, nameFor = namesFor) {
    if (!value) return;
    for (const key of keys) if (own(value, key)) set(doc, o, nameFor(key), value[key]);
  }

  function readValue(doc, raw, path = new Set()) {
    const value = resolve(doc, raw);
    if (!value || typeof value !== 'object') return value;
    if (path.has(value)) return undefined;
    path.add(value);
    let result;
    if (Array.isArray(value)) {
      result = value.map(item => readValue(doc, item, path));
    } else if (Codec.isListRecord ? Codec.isListRecord(doc, value) : (findField(doc, value, ['_items']) && findField(doc, value, ['_size']))) {
      result = items(doc, value).map(item => readValue(doc, item, path));
    } else {
      const keys = fieldsOf(doc, value);
      result = Object.fromEntries(keys.map(k => [k, readValue(doc, get(doc, value, [k]), path)]));
    }
    path.delete(value);
    return result;
  }

  const readList = (doc, o, key) => items(doc, list(doc, o, key)).map(raw => readValue(doc, raw));
  const attrNames = k => k.startsWith('max') ? [pascal(k), k, '_' + k, '_history' + pascal(k)] : ['_' + k, k, pascal(k)];

  function readStudent(doc, o, idx, catalog) {
    const result = { idx, ...readFields(doc, o, studentFields) };
    const level = catalog.levels?.get(result.levelId) ?? catalog.studentLevels?.get(result.levelId);
    result.levelName ??= level?.name;
    result.levelValue ??= level?.levelValue ?? level?.value;
    result.attr = readFields(doc, child(doc, o, 'attr'), attrFields, attrNames);
    result.kidneys = readList(doc, o, 'kidneys');
    const skills = child(doc, o, 'skillSystemGameData');
    for (const key of studentLists) result[key] = readList(doc, skills, key);
    for (const [key, [name, type, keys]] of Object.entries(equipment)) {
      result[key] = readValue(doc, field(doc, o, name)) ?? null;
    }
    return result;
  }

  function readState(doc, catalog = defaultCatalog) {
    const kind = detectSaveKind(doc);
    const root = rootOf(doc);
    const meta = { kind };
    if (kind === 'StoreData') return { meta, summarySlots: readList(doc, root, 'summarySlots') };
    if (kind !== 'PlayerGameData') return { meta };
    const [ps] = getTargetSchools(doc);
    const index = createCatalogIndex(catalog);
    return {
      meta: { ...meta, ...readFields(doc, root, metaFields) },
      school: readFields(doc, ps, schoolFields),
      students: items(doc, list(doc, ps, 'students')).map((raw, i) => readStudent(doc, resolve(doc, raw), i, index)),
      warehouse: Object.fromEntries(Object.keys(warehouseTypes).map(key => [key, readList(doc, ps, key)])),
      buildings: readList(doc, ps, 'buildings'),
      diplomacy: readList(doc, ps, 'diplomacy'),
      futuresPrices: readList(doc, child(doc, root, 'globalAttr'), 'futuresPrices')
    };
  }

  const assembly = 'Assembly-CSharp, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null';

  function newInstance(doc, type, values) {
    const name = type.startsWith('SGame.') ? type : 'SGame.' + type;
    const libraryId = Codec.findLibraryId(doc, assembly);
    const metadataId = Codec.findMetadataId(doc, name);
    if (metadataId == null) throw new Error('클래스 정보를 찾을 수 없습니다. ' + name);
    const object = Codec.createClassInstance(doc, metadataId, Codec.nextObjectId(doc), libraryId);
    Codec.insertRecordBeforeEnd(doc, object);
    for (const [key, value] of Object.entries(values)) set(doc, object, namesFor(key), value);
    return object;
  }

  function patchValue(doc, target, data) {
    for (const [key, value] of Object.entries(data)) {
      const current = resolve(doc, get(doc, target, [key]));
      if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object') {
        patchValue(doc, current, value);
      } else if (Array.isArray(value) && current && typeof current === 'object') {
        syncList(doc, current, value, key);
      } else {
        set(doc, target, [key], value);
      }
    }
  }

  const identityKeys = words('id stuId studentId schoolDataId schoolId propId materialId skillId weaponId armorId buildingId futureId kidneyId slotId');
  function identity(row) {
    if (!row || typeof row !== 'object') return undefined;
    const key = identityKeys.find(k => row[k] != null);
    return key === undefined ? undefined : String(row[key]);
  }

  function syncList(doc, target, rows, key, update = patchValue, seen) {
    if (!Array.isArray(rows)) return;
    if (!target) {
      if (rows.length) throw new Error('저장 목록을 찾을 수 없습니다. ' + key);
      return;
    }
    if (seen?.has(target)) return;
    seen?.add(target);
    const original = items(doc, target).slice();
    const existing = original.map(raw => {
      const value = resolve(doc, raw);
      return { value, id: identity(readValue(doc, raw)), used: false };
    });
    const sample = existing.find(row => row.value && typeof row.value === 'object')?.value;
    const type = className(sample) || className(sample && doc.objects[sample.metadataId]) || listTypes[key];
    const desired = rows.map((row, i) => {
      if (row == null || typeof row !== 'object') return row;
      const id = identity(row);
      const same = entry => entry && !entry.used && entry.value && typeof entry.value === 'object';
      const candidate = id === undefined
        ? (same(existing[i]) ? existing[i] : existing.find(same))
        : existing.find(entry => same(entry) && entry.id === id);
      if (candidate) {
        candidate.used = true;
        update(doc, candidate.value, row);
        return candidate.value;
      }
      if (!type) throw new Error('목록 항목의 클래스를 찾을 수 없습니다. ' + key);
      const value = newInstance(doc, type, {});
      update(doc, value, row);
      return value;
    });
    let prefix = 0;
    while (prefix < desired.length && prefix < original.length &&
      Object.is(desired[prefix], existing[prefix].value)) prefix++;
    for (let i = original.length - 1; i >= prefix; i--) Codec.listRemoveAt(doc, target, i);
    for (let i = prefix; i < desired.length; i++) Codec.listAddItem(doc, target, desired[i]);
  }

  function writeStudent(doc, o, data, seen) {
    writeFields(doc, o, data, studentFields);
    const attr = child(doc, o, 'attr');
    writeFields(doc, attr, data.attr, attrFields, attrNames);
    for (const key of attrFields.filter(k => k.startsWith('max'))) {
      set(doc, attr, ['_history' + pascal(key)], data.attr?.[key]);
    }
    syncList(doc, list(doc, o, 'kidneys'), data.kidneys, 'kidneys', patchValue, seen);
    const skills = child(doc, o, 'skillSystemGameData');
    for (const key of studentLists) syncList(doc, list(doc, skills, key), data[key], key, patchValue, seen);
    for (const [key, [name, type, keys]] of Object.entries(equipment)) {
      if (!own(data, key)) continue;
      let item = child(doc, o, name);
      if (data[key] === null) {
        set(doc, o, [name], null);
      } else if (data[key]) {
        if (!item) {
          item = newInstance(doc, type, {});
          set(doc, o, [name], item);
        }
        patchValue(doc, item, data[key]);
        writeFields(doc, item, data[key], keys, k => [k, pascal(k), '_' + k]);
      }
    }
  }

  function applyState(doc, state) {
    const kind = detectSaveKind(doc);
    const root = rootOf(doc);
    if (state.meta?.kind && state.meta.kind !== kind) throw new Error('저장 종류가 일치하지 않습니다.');
    if (kind === 'StoreData') {
      syncList(doc, list(doc, root, 'summarySlots'), state.summarySlots, 'summarySlots');
    } else if (kind === 'PlayerGameData') {
      writeFields(doc, root, state.meta, metaFields);
      const seen = new Set();
      for (const school of getTargetSchools(doc)) {
        writeFields(doc, school, state.school, schoolFields);
        syncList(doc, list(doc, school, 'students'), state.students, 'students',
          (d, student, data) => writeStudent(d, student, data, seen), seen);
        for (const key of Object.keys(warehouseTypes)) {
          syncList(doc, list(doc, school, key), state.warehouse?.[key], key, patchValue, seen);
        }
        for (const key of ['buildings', 'diplomacy']) {
          syncList(doc, list(doc, school, key), state[key], key, patchValue, seen);
        }
      }
      syncList(doc, list(doc, child(doc, root, 'globalAttr'), 'futuresPrices'), state.futuresPrices, 'futuresPrices');
    } else {
      throw new Error('알 수 없는 저장 종류입니다.');
    }
    return doc;
  }

  function formatGameDate(dateTime, catalog) {
    if (dateTime && typeof dateTime === 'object' && dateTime.year != null) {
      return `${dateTime.year}년 ${dateTime.month ?? 1}월 ${dateTime.day ?? 1}일`;
    }
    const day = Math.max(0, (Math.trunc(Number(dateTime)) || 1) - 1);
    return `${Math.floor(day / 360) + 1}년 ${Math.floor(day % 360 / 30) + 1}월 ${day % 30 + 1}일`;
  }

  function computeCombatStats(student) {
    const { str = 0, agi = 0, vit = 0 } = student?.attr ?? student ?? {};
    const power = Math.max(str, agi);
    return {
      maxHp: vit * 417,
      atk: power * 11.4,
      dzMax: 200,
      dispatchPower: Math.round(power * 0.5 + Number(student.levelValue ?? 0))
    };
  }

  const PRESETS = [
    { id: 'wealth', name: '재산 확충', description: '돈과 식량을 늘립니다.' },
    { id: 'school_max', name: '문파 성장', description: '문파 레벨과 저장 한도를 높입니다.' },
    { id: 'disciples_god', name: '제자 강화', description: '모든 제자의 기본 능력치를 높입니다.' },
    { id: 'disciples_heal', name: '제자 치료', description: '모든 제자의 질병을 치료하고 체력을 회복합니다.' },
    { id: 'supply_pack', name: '보급품 확충', description: '창고에 있는 소모품과 재료의 수량을 늘립니다.' },
    { id: 'diplomacy_max', name: '외교 개선', description: '다른 문파와의 우호도를 높입니다.' }
  ];

  function raise(o, key, minimum) {
    if (o) o[key] = Math.max(Number(o[key]) || 0, minimum);
  }

  function applyPreset(state, presetId) {
    const students = state.students ?? [];
    switch (presetId) {
      case 'wealth':
        for (const key of ['money', 'jhMoney', 'food']) raise(state.school, key, 1000000);
        break;
      case 'school_max':
        for (const [key, value] of Object.entries({ schoolLevel: 10, exp: 1000000, maxHistoryExp: 1000000, maxStorageCount: 999, maxStuStorageCount: 999 })) {
          raise(state.school, key, value);
        }
        break;
      case 'disciples_god':
        for (const student of students) {
          const attr = student.attr ??= {};
          for (const key of ['str', 'agi', 'luk', 'vit', 'wis', 'spr']) {
            raise(attr, key, 100);
            raise(attr, 'max' + pascal(key), attr[key]);
          }
          raise(attr, 'loyalty', 100);
          attr.hp = computeCombatStats(student).maxHp;
        }
        break;
      case 'disciples_heal':
        for (const student of students) {
          student.ill = typeof student.ill === 'boolean' ? false : 0;
          student.hasTreatedIll = true;
          (student.attr ??= {}).hp = computeCombatStats(student).maxHp;
        }
        break;
      case 'supply_pack':
        for (const group of ['props', 'originMaterials', 'prepareMaterials', 'hiddenWeapons']) {
          for (const row of state.warehouse?.[group] ?? []) {
            const key = ['count', 'num', 'amount', 'quantity'].find(k => own(row, k));
            if (key) raise(row, key, 99);
          }
        }
        break;
      case 'diplomacy_max':
        for (const row of state.diplomacy ?? []) {
          const key = ['friend', 'friendValue', 'schoolFriendValue', 'relationValue', 'relationshipValue', 'favor', 'value'].find(k => own(row, k));
          if (key) raise(row, key, 100);
        }
        break;
      default:
        throw new RangeError('알 수 없는 프리셋입니다. ' + presetId);
    }
    return state;
  }

  function validateState(state) {
    const errors = [];
    const warnings = [];
    const kind = state?.meta?.kind;
    if (kind !== 'PlayerGameData' && kind !== 'StoreData') errors.push('저장 종류를 확인하세요.');
    if (kind === 'StoreData' && !Array.isArray(state.summarySlots)) errors.push('저장 슬롯 목록이 필요합니다.');
    if (kind === 'PlayerGameData') {
      if (!state.school || typeof state.school !== 'object') errors.push('문파 정보가 필요합니다.');
      for (const key of ['students', 'buildings', 'diplomacy', 'futuresPrices']) {
        if (!Array.isArray(state[key])) errors.push(`${key} 목록이 필요합니다.`);
      }
      for (const key of Object.keys(warehouseTypes)) {
        if (!Array.isArray(state.warehouse?.[key])) errors.push(`warehouse.${key} 목록이 필요합니다.`);
      }
      for (const key of ['money', 'jhMoney', 'food', 'exp', 'maxStorageCount', 'maxStuStorageCount']) {
        const val = state.school?.[key];
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) errors.push(`school.${key} 값은 0 이상의 숫자여야 합니다.`);
      }
      for (const student of Array.isArray(state.students) ? state.students : []) {
        if (!student?.attr) {
          errors.push('제자 능력치가 필요합니다.');
          continue;
        }
        for (const key of ['str', 'agi', 'luk', 'vit', 'wis', 'spr']) {
          if (student.attr[key] > student.attr['max' + pascal(key)]) warnings.push(`${student.name ?? student.id}.${key} 값이 상한을 넘습니다.`);
        }
      }
    }
    function visit(value, path) {
      if (typeof value === 'number' && !Number.isFinite(value)) errors.push(`${path} 값은 유한한 수여야 합니다.`);
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) visit(child, path ? path + '.' + key : key);
      }
    }
    visit(state, '');
    return { valid: errors.length === 0, errors, warnings };
  }

  function diffStates(before, after) {
    const changes = [];
    function compare(a, b, label) {
      if (Object.is(a, b)) return;
      if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
          compare(a[key], b[key], Array.isArray(a) ? `${label}[${key}]` : label ? `${label}.${key}` : key);
        }
      } else {
        changes.push({ label, before: a, after: b });
      }
    }
    compare(before, after, '');
    return changes;
  }

  function createDemoNrbfBytes() {
    const records = [];
    const objects = Object.create(null);
    const libraries = { 1: assembly };
    let nextId = 2;
    const record = (recordType, value) => ({ recordType, type: recordType, ...value });
    const ref = id => record(9, { idRef: id, refId: id });
    records.push(record(0, { rootId: 1, headerId: -1, majorVersion: 1, minorVersion: 0 }));
    records.push(record(12, { libraryId: 1, libraryName: assembly, name: assembly }));

    function register(object) {
      objects[object.objectId] = object;
      records.push(object);
      return ref(object.objectId);
    }

    function instance(name, values, objectId = nextId++) {
      const members = Object.entries(values).map(([name, value]) => {
        let binaryType = 2; // Object
        let additionalInfo = null;
        if (typeof value === 'boolean') {
          binaryType = 0;
          additionalInfo = { primitiveType: 1 };
        } else if (typeof value === 'number') {
          binaryType = 0;
          additionalInfo = { primitiveType: 8 };
        } else if (typeof value === 'string') {
          binaryType = 1; // String
          value = register(record(6, { objectId: nextId++, value, string: value }));
        } else if (value === null) {
          value = record(10, { rawRecord: null });
        } else if (value?.recordType === 9 && objects[value.idRef]?.recordType === 16) {
          binaryType = 5; // ObjectArray
        }
        return { name, binaryType, additionalInfo, value };
      });
      return register(record(5, {
        objectId,
        className: name,
        memberNames: members.map(member => member.name),
        binaryTypes: members.map(member => member.binaryType),
        additionalInfos: members.map(member => member.additionalInfo),
        members,
        fields: Object.fromEntries(members.map(member => [member.name, member.value])),
        libraryId: 1,
        rawRecord: null
      }));
    }

    function demoList(values) {
      const backingRef = register(record(16, {
        objectId: nextId++,
        length: values.length,
        items: values,
        rawRecord: null
      }));

      return instance('System.Collections.Generic.List`1[[System.Object, mscorlib]]', {
        _items: backingRef,
        _size: values.length,
        _version: 0
      });
    }

    function student(id, name, firstName, secondName) {
      const attr = {};
      for (const key of attrFields) {
        attr[attrNames(key)[0]] = key === 'hp' ? 8340 : 20;
        if (key.startsWith('max')) attr['_history' + pascal(key)] = 20;
      }
      return instance('SGame.StudentGameData', {
        id, name, firstName, secondName, stuJobId: 0, sex: 0, levelId: 1, levelName: '입문',
        levelValue: 1, goodEvilValue: 0, bornAge: 18, bornDay: 1, ill: 0, hasTreatedIll: false,
        schoolFriendValue: 50, happyValue: 50, aptitudeLevel: 1, aptitudeValue: 20,
        attr: instance('SGame.BaseAttribute', attr),
        kidneyList: demoList([]),
        skillSystemGameData: instance('SGame.SkillSystemGameData', {
          learnedSkills: demoList([]), storageBooks: demoList([]),
          inPowerSkillIds: demoList([]), outPowerSkillIds: demoList([])
        }),
        mainWeaponGameData: null, armorGameData: null
      });
    }

    const school = instance('SGame.SchoolGameData', {
      schoolDataId: 1, name: '유운영', schoolLevel: 1, money: 1000, jhMoney: 100, food: 300,
      exp: 0, maxHistoryExp: 0, goodEvilValue: 0, standpoint: 0, maxStorageCount: 100,
      maxStuStorageCount: 20, leaderStudentId: 1,
      studentList: demoList([student(1, '사도검봉', '사도', '검봉'), student(2, '손연', '손', '연')]),
      storagePropList: demoList([1, 2].map(propId => instance('SGame.StoragePropData', { propId, count: 5 }))),
      storageOriginMaterialList: demoList([]), storagePrepareMaterialList: demoList([]),
      storageHiddenWeaponList: demoList([]), storageSkillList: demoList([]), storageFutureList: demoList([]),
      storageWeaponList: demoList([]), storageArmorList: demoList([]),
      buildingList: demoList([1, 2].map(buildingId => instance('SGame.BuildingGameData', { buildingId, level: 1 }))),
      interactiveSchoolInfoList: demoList([instance('SGame.InteractiveSchoolInfo', { schoolDataId: 2, friendValue: 20 })])
    });
    instance('SGame.PlayerGameData', {
      dateTime: 1, curSchoolId: 1, genId: 3, genWeaponId: 1, genArmorId: 1, genSkillId: 1,
      jhFightFinishedLevel: 0, playerSchool: school, schoolGameDataList: demoList([school]),
      globalAttr: instance('SGame.GlobalAttr', { futurePrices: demoList([]) })
    }, 1);
    records.splice(2, 0, records.pop());
    records.push(record(11, {}));
    const bytes = Codec.serializeNrbf({ rootId: 1, header: records[0], records, objects, libraries });
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  return {
    detectSaveKind, getTargetSchools, createCatalogIndex, readState, applyState, formatGameDate,
    computeCombatStats, PRESETS, applyPreset, validateState, diffStates, createDemoNrbfBytes
  };
});
