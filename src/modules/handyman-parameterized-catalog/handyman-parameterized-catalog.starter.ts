import type {
  HandymanServiceAttributeDataType,
  HandymanServicePriceBasis,
  HandymanServicePricingMode,
} from './handyman-parameterized-catalog.types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — the governed STARTER definition.
 *
 * This file is the single, reviewable statement of "what a Client gets
 * when the starter import runs": 8 categories, 24 generic Handyman
 * services, the technical attribute definitions of each service, one
 * default variant per service, the per-service commercial posture, and the
 * five quantity UOMs the pricing bases need.
 *
 * Three laws of this definition:
 *
 *  1. NO AMOUNTS. The starter never invents a price. A price rule points
 *     at the EXISTING governed price authority (`price_catalog_entries`);
 *     until an administrator prices a service there is simply no price,
 *     and the catalogue says so (inspection / manual review) instead of
 *     fabricating one.
 *
 *  2. NO HARD-CODED DOMAIN LOGIC. AC capacity, AC type and inverter are
 *     ordinary attribute rows like any other — the engine only knows the
 *     attribute DATA TYPE, never "AC".
 *
 *  3. EVERYTHING IS IDEMPOTENT-IMPORTABLE. Codes are stable, unique per
 *     scope and never rewritten by a later import.
 */

/** One attribute definition of the starter catalog. */
export type HandymanStarterAttribute = {
  code: string;
  name: string;
  description: string;
  dataType: HandymanServiceAttributeDataType;
  unit?: string;
  required: boolean;
  allowFreeValue?: boolean;
  allowedValues?: { code: string; label: string }[];
  sortOrder: number;
};

/** One service of the starter catalog. */
export type HandymanStarterService = {
  code: string;
  name: string;
  description: string;
  categoryCode: string;
  pricingMode: HandymanServicePricingMode;
  priceBasis: HandymanServicePriceBasis;
  attributes: HandymanStarterAttribute[];
};

/** One governed category of the starter catalog. */
export type HandymanStarterCategory = {
  code: string;
  name: string;
  description: string;
};

/** The default variant every starter service receives. */
export const HANDYMAN_STARTER_VARIANT_CODE = 'STANDARD';
export const HANDYMAN_STARTER_VARIANT_NAME = 'Standard';

/**
 * The quantity UOM each price basis counts in. The starter import creates
 * these five UOMs per Client (idempotently); a price rule can only be
 * quoted when its basis' UOM exists for the Client.
 */
export const HANDYMAN_STARTER_UOMS: readonly {
  code: string;
  name: string;
  symbol: string;
  category: string;
  basis: HandymanServicePriceBasis;
}[] = [
  {
    code: 'HM_UNIT',
    name: 'Unit',
    symbol: 'unit',
    category: 'COUNT',
    basis: 'UNIT',
  },
  {
    code: 'HM_POINT',
    name: 'Point',
    symbol: 'pt',
    category: 'COUNT',
    basis: 'POINT',
  },
  {
    code: 'HM_METER',
    name: 'Meter',
    symbol: 'm',
    category: 'LENGTH',
    basis: 'METER',
  },
  {
    code: 'HM_SQM',
    name: 'Square Meter',
    symbol: 'm2',
    category: 'AREA',
    basis: 'SQM',
  },
  {
    code: 'HM_VISIT',
    name: 'Visit',
    symbol: 'visit',
    category: 'COUNT',
    basis: 'VISIT',
  },
];

/** The 8 governed categories. */
export const HANDYMAN_STARTER_CATEGORIES: readonly HandymanStarterCategory[] = [
  {
    code: 'AIR_CONDITIONING',
    name: 'Air Conditioning & Ventilation',
    description:
      'Instalasi, penggantian, perawatan dan penanganan unit air conditioning.',
  },
  {
    code: 'PLUMBING',
    name: 'Plumbing & Sanitary',
    description:
      'Perbaikan titik air, pipa, sanitair dan water heater unit-unit hunian.',
  },
  {
    code: 'ELECTRICAL',
    name: 'Electrical & Lighting',
    description:
      'Pencahayaan, soket, saklar, panel dan diagnosis gangguan listrik.',
  },
  {
    code: 'FURNITURE',
    name: 'Furniture & Assembly',
    description:
      'Perakitan, perbaikan, pemindahan dan pemasangan perabot.',
  },
  {
    code: 'APPLIANCE',
    name: 'Home Appliance',
    description:
      'Pemasangan, perbaikan dan perawatan elektrolux rumah tangga.',
  },
  {
    code: 'MINOR_CIVIL',
    name: 'Minor Civil & Finishing',
    description:
      'Pekerjaan kecil civil: keramik, pengecatan, plafon dan finishing dinding.',
  },
  {
    code: 'LOCK_SECURITY',
    name: 'Door, Lock & Security',
    description:
      'Pintu, kunci, interkom dan perangkat akses gedung.',
  },
  {
    code: 'GENERAL_MAINTENANCE',
    name: 'General Maintenance',
    description:
      'Perawatan umum, perbaikan kecil, dan pekerjaan satuan lainnya.',
  },
];

/* ------------------------------------------------------------------ */
/* Reusable attribute definitions.                                     */
/* ------------------------------------------------------------------ */

const AC_CAPACITY: HandymanStarterAttribute = {
  code: 'AC_CAPACITY',
  name: 'Kapasitas AC',
  description:
    'Kapasitas unit air conditioning dalam PK. Nilai standar yang tersedia: ' +
    '0.5 / 0.75 / 1 / 1.25 / 1.5 / 2 / 2.5 / 3 PK. Ukuran tambahan di luar ' +
    'daftar standar dapat dikonfigurasi (nilai bebas diizinkan).',
  dataType: 'NUMBER',
  unit: 'PK',
  required: true,
  allowFreeValue: true,
  allowedValues: [
    '0.5',
    '0.75',
    '1',
    '1.25',
    '1.5',
    '2',
    '2.5',
    '3',
    '4',
    '5',
    '6',
  ].map((value) => ({ code: value, label: `${value} PK` })),
  sortOrder: 10,
};

const AC_TYPE: HandymanStarterAttribute = {
  code: 'AC_TYPE',
  name: 'Tipe Unit AC',
  description:
    'Bentuk unit air conditioning yang dipasang: split, cassette, standing atau ducted.',
  dataType: 'ENUM',
  required: true,
  allowedValues: [
    { code: 'SPLIT', label: 'Split' },
    { code: 'CASSETTE', label: 'Cassette' },
    { code: 'STANDING', label: 'Standing' },
    { code: 'DUCTED', label: 'Ducted' },
  ],
  sortOrder: 20,
};

const AC_DRIVE_TYPE: HandymanStarterAttribute = {
  code: 'AC_DRIVE_TYPE',
  name: 'Tipe Kompresor',
  description:
    'Tipe kompresor unit air conditioning: inverter atau non-inverter.',
  dataType: 'ENUM',
  required: true,
  allowedValues: [
    { code: 'INVERTER', label: 'Inverter' },
    { code: 'NON_INVERTER', label: 'Non-Inverter' },
  ],
  sortOrder: 30,
};

const AC_EXISTING_UNIT: HandymanStarterAttribute = {
  code: 'AC_EXISTING_UNIT',
  name: 'Unit AC Existing',
  description:
    'Keberadaan unit air conditioning existing di lokasi (relevan untuk penggantian).',
  dataType: 'ENUM',
  required: true,
  allowedValues: [
    { code: 'PRESENT', label: 'Ada Unit Existing' },
    { code: 'ABSENT', label: 'Tanpa Unit Existing' },
  ],
  sortOrder: 40,
};

function enumAttribute(
  code: string,
  name: string,
  description: string,
  values: { code: string; label: string }[],
  required = false,
  sortOrder = 10,
): HandymanStarterAttribute {
  return {
    code,
    name,
    description,
    dataType: 'ENUM',
    required,
    allowedValues: values,
    sortOrder,
  };
}

function numberAttribute(
  code: string,
  name: string,
  description: string,
  unit: string,
  required = false,
  sortOrder = 10,
): HandymanStarterAttribute {
  return {
    code,
    name,
    description,
    dataType: 'NUMBER',
    unit,
    required,
    sortOrder,
  };
}

function textAttribute(
  code: string,
  name: string,
  description: string,
  required = false,
  sortOrder = 10,
): HandymanStarterAttribute {
  return {
    code,
    name,
    description,
    dataType: 'TEXT',
    required,
    sortOrder,
  };
}

/* ------------------------------------------------------------------ */
/* The 24 generic services.                                            */
/* ------------------------------------------------------------------ */

export const HANDYMAN_STARTER_SERVICES: readonly HandymanStarterService[] = [
  /* ---- 1. Air Conditioning ---- */
  {
    code: 'AC_INSTALLATION',
    name: 'Instalasi Unit AC',
    description:
      'Pemasangan unit air conditioning baru beserta pipa refrigeran dan bracket.',
    categoryCode: 'AIR_CONDITIONING',
    pricingMode: 'FIXED',
    priceBasis: 'UNIT',
    attributes: [AC_CAPACITY, AC_TYPE, AC_DRIVE_TYPE],
  },
  {
    code: 'AC_REPLACEMENT',
    name: 'Penggantian Unit AC',
    description:
      'Penggantian unit air conditioning existing dengan unit baru.',
    categoryCode: 'AIR_CONDITIONING',
    pricingMode: 'FIXED',
    priceBasis: 'UNIT',
    attributes: [AC_CAPACITY, AC_TYPE, AC_DRIVE_TYPE, AC_EXISTING_UNIT],
  },
  {
    code: 'AC_MAINTENANCE',
    name: 'Perawatan & Servis AC',
    description:
      'Pembersihan unit air conditioning, cek tekanan refrigeran, dan penggantian filter.',
    categoryCode: 'AIR_CONDITIONING',
    pricingMode: 'FIXED',
    priceBasis: 'UNIT',
    attributes: [AC_CAPACITY, AC_TYPE, AC_DRIVE_TYPE],
  },

  /* ---- 2. Plumbing ---- */
  {
    code: 'PLUMBING_POINT_REPAIR',
    name: 'Perbaikan Titik Air',
    description:
      'Perbaikan kebocoran, penyumbatan, dan penggantian fitting titik air.',
    categoryCode: 'PLUMBING',
    pricingMode: 'ESTIMATED',
    priceBasis: 'POINT',
    attributes: [
      numberAttribute(
        'PLUMBING_POINT_COUNT',
        'Jumlah Titik Air',
        'Jumlah titik air yang diperbaiki dalam satu item pekerjaan.',
        'point',
        true,
        10,
      ),
      enumAttribute(
        'PLUMBING_JOINT_TYPE',
        'Jenis Sambungan',
        'Jenis sambungan pipa yang terlibat pada perbaikan.',
        [
          { code: 'SCREWED', label: 'Screw' },
          { code: 'PRESS_FIT', label: 'Press Fit' },
          { code: 'WELDED', label: 'Welded' },
          { code: 'FLEXIBLE', label: 'Flexible' },
        ],
        false,
        20,
      ),
    ],
  },
  {
    code: 'PLUMBING_PIPE_REPAIR',
    name: 'Perbaikan Pipa',
    description:
      'Perbaikan atau penggantian pipa air dan pipa buangan dengan pengukuran meter.',
    categoryCode: 'PLUMBING',
    pricingMode: 'ESTIMATED',
    priceBasis: 'METER',
    attributes: [
      numberAttribute(
        'PLUMBING_PIPE_LENGTH_M',
        'Panjang Pipa (meter)',
        'Panjang pipa yang diperbaiki atau digantikan dalam meter.',
        'm',
        true,
        10,
      ),
      enumAttribute(
        'PLUMBING_PIPE_MATERIAL',
        'Material Pipa',
        'Material pipa yang digunakan pada pekerjaan.',
        [
          { code: 'PVC', label: 'PVC' },
          { code: 'PEX', label: 'PEX' },
          { code: 'COPPER', label: 'Copper' },
          { code: 'STEEL', label: 'Steel' },
        ],
        false,
        20,
      ),
    ],
  },
  {
    code: 'PLUMBING_WATER_HEATER',
    name: 'Servis Water Heater',
    description:
      'Perawatan, penggantian komponen, dan perbaikan water heater unit-unit.',
    categoryCode: 'PLUMBING',
    pricingMode: 'ESTIMATED',
    priceBasis: 'UNIT',
    attributes: [
      numberAttribute(
        'PLUMBING_WATER_HEATER_CAPACITY_L',
        'Kapasitas Water Heater (liter)',
        'Kapasitas tangki water heater dalam liter.',
        'l',
        false,
        10,
      ),
      enumAttribute(
        'PLUMBING_WATER_HEATER_TYPE',
        'Jenis Water Heater',
        'Jenis water heater yang dilayani.',
        [
          { code: 'STORAGE', label: 'Storage Tank' },
          { code: 'INSTANT', label: 'Instant' },
          { code: 'HEAT_PUMP', label: 'Heat Pump' },
        ],
        false,
        20,
      ),
    ],
  },

  /* ---- 3. Electrical ---- */
  {
    code: 'ELECTRICAL_LIGHTING',
    name: 'Pemasangan & Perbaikan Pencahayaan',
    description:
      'Pemasangan dan perbaikan lampu, downlight, dan instalasi pencahayaan unit.',
    categoryCode: 'ELECTRICAL',
    pricingMode: 'FIXED',
    priceBasis: 'POINT',
    attributes: [
      numberAttribute(
        'ELECTRICAL_LIGHT_POINT_COUNT',
        'Jumlah titik lampu',
        'Jumlah titik pencahayaan yang dipasang atau diperbaiki.',
        'point',
        true,
        10,
      ),
      enumAttribute(
        'ELECTRICAL_LIGHT_TYPE',
        'Jenis Lampu',
        'Jenis instalasi pencahayaan.',
        [
          { code: 'LED', label: 'LED' },
          { code: 'DOWNLIGHT', label: 'Downlight' },
          { code: 'SPOTLIGHT', label: 'Spotlight' },
          { code: 'FLOODLIGHT', label: 'Floodlight' },
        ],
        false,
        20,
      ),
    ],
  },
  {
    code: 'ELECTRICAL_OUTLET',
    name: 'Perbaikan Soket & Saklar',
    description:
      'Perbaikan dan penggantian soket, saklar, stopkontak, dan puntos listrik.',
    categoryCode: 'ELECTRICAL',
    pricingMode: 'FIXED',
    priceBasis: 'POINT',
    attributes: [
      numberAttribute(
        'ELECTRICAL_OUTLET_POINT_COUNT',
        'Jumlah titik listrik',
        'Jumlah titik listrik (soket/saklar) yang diperbaiki.',
        'point',
        true,
        10,
      ),
      enumAttribute(
        'ELECTRICAL_CIRCUIT_TYPE',
        'Jenis Instalasi',
        'Jenis instalasi listrik yang terdampak.',
        [
          { code: 'POWER', label: 'Power' },
          { code: 'LIGHTING', label: 'Lighting' },
          { code: 'DATA', label: 'Data' },
          { code: 'MIXED', label: 'Mixed' },
        ],
        false,
        20,
      ),
    ],
  },
  {
    code: 'ELECTRICAL_DIAGNOSIS',
    name: 'Diagnosis Gangguan Listrik',
    description:
      'Kunjungan diagnosis gangguan listrik. Harga baru dapat ditetapkan setelah inspeksi.',
    categoryCode: 'ELECTRICAL',
    pricingMode: 'INSPECTION_FIRST',
    priceBasis: 'VISIT',
    attributes: [
      enumAttribute(
        'ELECTRICAL_DIAGNOSIS_SYMPTOM',
        'Gejala Gangguan',
        'Gejala utama yang dilaporkan untuk kebutuhan diagnosis.',
        [
          { code: 'NO_POWER', label: 'Tidak Ada Daya' },
          { code: 'INTERMITTENT', label: 'Nyala-Nyala' },
          { code: 'TRIPPING', label: 'MCB Trip' },
          { code: 'BURNING_SMELL', label: 'Bau Terbakar' },
        ],
        true,
        10,
      ),
    ],
  },

  /* ---- 4. Furniture ---- */
  {
    code: 'FURNITURE_ASSEMBLY',
    name: 'Perakitan Perabot',
    description:
      'Perakitan perabot siap kirim (matras, lemari, kasur, dan perabot lain).',
    categoryCode: 'FURNITURE',
    pricingMode: 'FIXED',
    priceBasis: 'POINT',
    attributes: [
      numberAttribute(
        'FURNITURE_ITEM_COUNT',
        'Jumlah Perabot',
        'Jumlah unit perabot yang dirakit dalam satu item pekerjaan.',
        'item',
        true,
        10,
      ),
      enumAttribute(
        'FURNITURE_ASSEMBLY_COMPLEXITY',
        'Tingkat Kompleksitas',
        'Tingkat kompleksitas perakitan perabot.',
        [
          { code: 'SIMPLE', label: 'Simple' },
          { code: 'MODERATE', label: 'Moderate' },
          { code: 'COMPLEX', label: 'Complex' },
        ],
        false,
        20,
      ),
    ],
  },
  {
    code: 'FURNITURE_REPAIR',
    name: 'Perbaikan Perabot',
    description:
      'Perbaikan engsel, kunci, dan komponen perabot yang rusak.',
    categoryCode: 'FURNITURE',
    pricingMode: 'ESTIMATED',
    priceBasis: 'POINT',
    attributes: [
      numberAttribute(
        'FURNITURE_ITEM_COUNT',
        'Jumlah Perabot',
        'Jumlah unit perabot yang diperbaiki dalam satu item pekerjaan.',
        'item',
        true,
        10,
      ),
      enumAttribute(
        'FURNITURE_MATERIAL',
        'Material Perabot',
        'Material utama perabot yang diperbaiki.',
        [
          { code: 'WOOD', label: 'Kayu' },
          { code: 'METAL', label: 'Logam' },
          { code: 'PLASTIC', label: 'Plastik' },
          { code: 'ENGINEERED', label: 'Engineered Wood' },
        ],
        false,
        20,
      ),
    ],
  },
  {
    code: 'FURNITURE_MOVING',
    name: 'Pemindahan Perabot',
    description:
      'Pemindahan perabot antar unit atau antar lantai dengan bongkar-pasang.',
    categoryCode: 'FURNITURE',
    pricingMode: 'ESTIMATED',
    priceBasis: 'POINT',
    attributes: [
      numberAttribute(
        'FURNITURE_ITEM_COUNT',
        'Jumlah Perabot',
        'Jumlah unit perabot yang dipindahkan.',
        'item',
        true,
        10,
      ),
      enumAttribute(
        'FURNITURE_MOVING_DISTANCE_LEVEL',
        'Tingkat Jarak',
        'Tingkat jarak dan tingkat kesulitan pemindahan.',
        [
          { code: 'SAME_ROOM', label: 'Same Room' },
          { code: 'SAME_FLOOR', label: 'Same Floor' },
          { code: 'CROSS_FLOOR', label: 'Cross Floor' },
          { code: 'CROSS_BUILDING', label: 'Cross Building' },
        ],
        false,
        20,
      ),
    ],
  },

  /* ---- 5. Home Appliance ---- */
  {
    code: 'APPLIANCE_REPAIR',
    name: 'Perbaikan Elektrolux',
    description:
      'Diagnosis dan perbaikan kerusakan elektrolux rumah tangga.',
    categoryCode: 'APPLIANCE',
    pricingMode: 'ESTIMATED',
    priceBasis: 'UNIT',
    attributes: [
      enumAttribute(
        'APPLIANCE_TYPE',
        'Jenis Elektrolux',
        'Jenis elektrolux yang diperbaiki.',
        [
          { code: 'REFRIGERATOR', label: 'Kulkas' },
          { code: 'WASHING_MACHINE', label: 'Mesin Cuci' },
          { code: 'DRYER', label: 'Pengering' },
          { code: 'KITCHEN_HOOD', label: 'Hood Dapur' },
          { code: 'AIR_PURIFIER', label: 'Air Purifier' },
        ],
        true,
        10,
      ),
      numberAttribute(
        'APPLIANCE_CAPACITY',
        'Kapasitas Elektrolux',
        'Kapasitas elektrolux sesuai tipe produk (liter/kg).',
        'l',
        false,
        20,
      ),
    ],
  },
  {
    code: 'APPLIANCE_INSTALLATION',
    name: 'Pemasangan Elektrolux',
    description:
      'Pemasangan elektrolux rumah tangga baru dan uji fungsi.',
    categoryCode: 'APPLIANCE',
    pricingMode: 'FIXED',
    priceBasis: 'UNIT',
    attributes: [
      enumAttribute(
        'APPLIANCE_TYPE',
        'Jenis Elektrolux',
        'Jenis elektrolux yang dipasang.',
        [
          { code: 'REFRIGERATOR', label: 'Kulkas' },
          { code: 'WASHING_MACHINE', label: 'Mesin Cuci' },
          { code: 'DRYER', label: 'Pengering' },
          { code: 'KITCHEN_HOOD', label: 'Hood Dapur' },
          { code: 'AIR_PURIFIER', label: 'Air Purifier' },
        ],
        true,
        10,
      ),
      numberAttribute(
        'APPLIANCE_CAPACITY',
        'Kapasitas Elektrolux',
        'Kapasitas elektrolux sesuai tipe produk (liter/kg).',
        'l',
        false,
        20,
      ),
    ],
  },
  {
    code: 'APPLIANCE_MAINTENANCE',
    name: 'Perawatan Elektrolux',
    description:
      'Perawatan berkala elektrolux rumah tangga.',
    categoryCode: 'APPLIANCE',
    pricingMode: 'FIXED',
    priceBasis: 'UNIT',
    attributes: [
      enumAttribute(
        'APPLIANCE_TYPE',
        'Jenis Elektrolux',
        'Jenis elektrolux yang dirawat.',
        [
          { code: 'REFRIGERATOR', label: 'Kulkas' },
          { code: 'WASHING_MACHINE', label: 'Mesin Cuci' },
          { code: 'DRYER', label: 'Pengering' },
          { code: 'KITCHEN_HOOD', label: 'Hood Dapur' },
          { code: 'AIR_PURIFIER', label: 'Air Purifier' },
        ],
        true,
        10,
      ),
      textAttribute(
        'APPLIANCE_MAKE_MODEL',
        'Merek / Model',
        'Merek dan model elektrolux bila diketahui.',
        false,
        20,
      ),
    ],
  },

  /* ---- 6. Minor Civil ---- */
  {
    code: 'MINOR_CIVIL_TILE',
    name: 'Perbaikan Keramik & Lantai',
    description:
      'Pembongkaran dan pemasangan ulang keramik / lantai dengan pengukuran m2.',
    categoryCode: 'MINOR_CIVIL',
    pricingMode: 'ESTIMATED',
    priceBasis: 'SQM',
    attributes: [
      numberAttribute(
        'MINOR_CIVIL_AREA_SQM',
        'Luas Area (m2)',
        'Luas area pekerjaan dalam meter persegi.',
        'm2',
        true,
        10,
      ),
      enumAttribute(
        'MINOR_CIVIL_MATERIAL',
        'Material Floor',
        'Material lantai atau dinding yang digunakan.',
        [
          { code: 'CERAMIC', label: 'Keramik' },
          { code: 'GRANITE', label: 'Granit' },
          { code: 'MARBLE', label: 'Marmer' },
          { code: 'VINYL', label: 'Vinyl' },
        ],
        false,
        20,
      ),
    ],
  },
  {
    code: 'MINOR_CIVIL_PAINTING',
    name: 'Pengecatan Dinding & Plafon',
    description:
      'Pengecatan dinding atau plafon dengan pengukuran luas area m2.',
    categoryCode: 'MINOR_CIVIL',
    pricingMode: 'ESTIMATED',
    priceBasis: 'SQM',
    attributes: [
      numberAttribute(
        'MINOR_CIVIL_AREA_SQM',
        'Luas Area (m2)',
        'Luas area pengecatan dalam meter persegi.',
        'm2',
        true,
        10,
      ),
      enumAttribute(
        'MINOR_CIVIL_PAINT_SCOPE',
        'Cakupan Pengecatan',
        'Cakupan pekerjaan pengecatan.',
        [
          { code: 'INTERIOR', label: 'Interior' },
          { code: 'EXTERIOR', label: 'Exterior' },
          { code: 'WET_AREA', label: 'Wet Area' },
        ],
        false,
        20,
      ),
    ],
  },
  {
    code: 'MINOR_CIVIL_CEILING',
    name: 'Perbaikan Plafon',
    description:
      'Perbaikan plafon gypsum, PVC, atau plafon akibat kebocoran.',
    categoryCode: 'MINOR_CIVIL',
    pricingMode: 'ESTIMATED',
    priceBasis: 'SQM',
    attributes: [
      numberAttribute(
        'MINOR_CIVIL_AREA_SQM',
        'Luas Area (m2)',
        'Luas area plafon yang diperbaiki dalam meter persegi.',
        'm2',
        true,
        10,
      ),
      enumAttribute(
        'MINOR_CIVIL_CEILING_TYPE',
        'Jenis Plafon',
        'Jenis plafon yang diperbaiki.',
        [
          { code: 'GYPSUM', label: 'Gypsum' },
          { code: 'PVC', label: 'PVC' },
          { code: 'GYPTILE', label: 'Gyptile' },
          { code: 'CONCRETE', label: 'Concrete' },
        ],
        false,
        20,
      ),
    ],
  },

  /* ---- 7. Door, Lock & Security ---- */
  {
    code: 'LOCK_DOOR_REPAIR',
    name: 'Perbaikan Pintu & Kunci',
    description:
      'Perbaikan daun pintu, engsel, handle, dan kunci unit-unit hunian.',
    categoryCode: 'LOCK_SECURITY',
    pricingMode: 'ESTIMATED',
    priceBasis: 'POINT',
    attributes: [
      numberAttribute(
        'LOCK_DOOR_COUNT',
        'Jumlah Pintu',
        'Jumlah pintu yang diperbaiki dalam satu item pekerjaan.',
        'item',
        true,
        10,
      ),
      enumAttribute(
        'LOCK_TYPE',
        'Jenis Kunci',
        'Jenis kunci yang dikerjakan.',
        [
          { code: 'ANALOG', label: 'Analog' },
          { code: 'DIGITAL', label: 'Digital' },
          { code: 'SMART', label: 'Smart Lock' },
          { code: 'KEYLESS', label: 'Keyless' },
        ],
        false,
        20,
      ),
    ],
  },
  {
    code: 'LOCK_INSTALLATION',
    name: 'Pemasangan Kunci Baru',
    description:
      'Pemasangan kunci baru atau penggantian silinder kunci unit-unit.',
    categoryCode: 'LOCK_SECURITY',
    pricingMode: 'FIXED',
    priceBasis: 'POINT',
    attributes: [
      numberAttribute(
        'LOCK_DOOR_COUNT',
        'Jumlah Pintu',
        'Jumlah pintu yang dipasang kuncinya.',
        'item',
        true,
        10,
      ),
      enumAttribute(
        'LOCK_TYPE',
        'Jenis Kunci',
        'Jenis kunci yang dipasang.',
        [
          { code: 'ANALOG', label: 'Analog' },
          { code: 'DIGITAL', label: 'Digital' },
          { code: 'SMART', label: 'Smart Lock' },
          { code: 'KEYLESS', label: 'Keyless' },
        ],
        false,
        20,
      ),
    ],
  },
  {
    code: 'LOCK_ACCESS_INTERCOM',
    name: 'Perbaikan Interkom & Access',
    description:
      'Diagnosis dan perbaikan interkom atau perangkat access control. ' +
      'Harga ditetapkan setelah inspeksi.',
    categoryCode: 'LOCK_SECURITY',
    pricingMode: 'INSPECTION_FIRST',
    priceBasis: 'VISIT',
    attributes: [
      enumAttribute(
        'LOCK_ACCESS_DEVICE_TYPE',
        'Jenis Perangkat Access',
        'Jenis perangkat access control yang Complaint.',
        [
          { code: 'INTERCOM', label: 'Intercom' },
          { code: 'ACCESS_CARD', label: 'Access Card' },
          { code: 'FACE_RECOGNITION', label: 'Face Recognition' },
          { code: 'CCTV', label: 'CCTV' },
        ],
        true,
        10,
      ),
      numberAttribute(
        'LOCK_ACCESS_POINT_COUNT',
        'Jumlah Perangkat',
        'Jumlah perangkat access control yang terdampak.',
        'item',
        false,
        20,
      ),
    ],
  },

  /* ---- 8. General Maintenance ---- */
  {
    code: 'GENERAL_MAINTENANCE_VISIT',
    name: 'Kunjungan Perawatan Umum',
    description:
      'Kunjungan perawatan umum multi-poin yang tidak termasuk kategori lain.',
    categoryCode: 'GENERAL_MAINTENANCE',
    pricingMode: 'ESTIMATED',
    priceBasis: 'VISIT',
    attributes: [
      enumAttribute(
        'GENERAL_VISIT_SCOPE',
        'Cakupan Kunjungan',
        'Cakupan pekerjaan pada satu kunjungan.',
        [
          { code: 'IN_UNIT', label: 'Dalam Unit' },
          { code: 'COMMON_AREA', label: 'Area Umum' },
          { code: 'FACILITY', label: 'Fasilitas' },
        ],
        true,
        10,
      ),
      enumAttribute(
        'GENERAL_VISIT_DURATION_BAND',
        'Estimasi Durasi',
        'Perkiraan durasi pekerjaan kunjungan.',
        [
          { code: 'UNDER_1H', label: '< 1 Jam' },
          { code: '1_TO_3H', label: '1-3 Jam' },
          { code: 'HALF_DAY', label: 'Setengah Hari' },
          { code: 'FULL_DAY', label: 'Satu Hari' },
        ],
        false,
        20,
      ),
    ],
  },
  {
    code: 'GENERAL_HOLE_PATCHING',
    name: 'Perbaikan Lubang Dinding',
    description:
      'Penambalan lubang dan kerusakan kecil dinding atau plafon.',
    categoryCode: 'GENERAL_MAINTENANCE',
    pricingMode: 'ESTIMATED',
    priceBasis: 'POINT',
    attributes: [
      numberAttribute(
        'GENERAL_PATCH_POINT_COUNT',
        'Jumlah Titik Perbaikan',
        'Jumlah titik kerusakan yang ditambal.',
        'point',
        true,
        10,
      ),
      enumAttribute(
        'GENERAL_PATCH_SIZE',
        'Ukuran Kerusakan',
        'Ukuran perkiraan area kerusakan per titik.',
        [
          { code: 'SMALL', label: 'Kecil' },
          { code: 'MEDIUM', label: 'Sedang' },
          { code: 'LARGE', label: 'Besar' },
        ],
        false,
        20,
      ),
    ],
  },
  {
    code: 'GENERAL_SILICON_REPLACEMENT',
    name: 'Penggantian Silikon & Sealant',
    description:
      'Penggantian silikon atau sealant pada area basah dengan pengukuran meter.',
    categoryCode: 'GENERAL_MAINTENANCE',
    pricingMode: 'ESTIMATED',
    priceBasis: 'METER',
    attributes: [
      numberAttribute(
        'GENERAL_SEALANT_LENGTH_M',
        'Panjang Sealant (meter)',
        'Panjang silikon / sealant yang diganti dalam meter.',
        'm',
        true,
        10,
      ),
      enumAttribute(
        'GENERAL_SEALANT_SCOPE',
        'Lingkup Sealant',
        'Lingkup penggantian sealant.',
        [
          { code: 'BATHROOM', label: 'Kamar Mandi' },
          { code: 'KITCHEN', label: 'Dapur' },
          { code: 'WINDOW', label: 'Jendela' },
          { code: 'OTHER', label: 'Lainnya' },
        ],
        false,
        20,
      ),
    ],
  },
];

/** Invariant of the starter definition (asserted by the import + tests). */
export const HANDYMAN_STARTER_CATEGORY_COUNT = 8;
export const HANDYMAN_STARTER_SERVICE_COUNT = 24;
