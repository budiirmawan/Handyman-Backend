import type {
  StarterPackCategory,
  StarterPackService,
} from './service-catalog-master.types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — Apartment Indonesia Service Starter Pack.
 *
 * The frozen starter catalogue: 8 Service Categories and 24 Service Items.
 * Codes use the byte-identical grammar of `service_catalog.code`
 * (`/^[A-Z][A-Z0-9_-]*$/`, 2–64) so they are valid catalogue identities with
 * zero grammar friction. This file is pure reference data — no price is
 * defined anywhere; the catalogue never carries a default or nominal amount.
 */

export const STARTER_PACK_OPERATION_KEY = 'SERVICE_CATALOG_STARTER_PACK_IMPORT';

export const STARTER_PACK_CATEGORIES: readonly StarterPackCategory[] = [
  {
    code: 'AC_VENTILASI',
    name: 'AC & Ventilasi',
    description: 'Pemeliharaan dan perbaikan pendingin ruangan serta ventilasi.',
  },
  {
    code: 'LISTRIK',
    name: 'Listrik',
    description: 'Perbaikan dan pemasangan instalasi listrik perumahan.',
  },
  {
    code: 'PLUMBING',
    name: 'Plumbing',
    description: 'Perbaikan saluran air, keran, dan pipa.',
  },
  {
    code: 'SANITASI',
    name: 'Sanitasi',
    description: 'Perbaikan sanitasi kamar mandi dan wastafel.',
  },
  {
    code: 'PINTU_KUNCI',
    name: 'Pintu & Kunci',
    description: 'Perbaikan pintu, engsel, kunci, dan handle.',
  },
  {
    code: 'INTERIOR',
    name: 'Interior',
    description: 'Perbaikan plafon, dinding, dan pengecatan minor.',
  },
  {
    code: 'FURNITURE',
    name: 'Furniture',
    description: 'Perbaikan dan pemasangan furniture.',
  },
  {
    code: 'GENERAL_MAINTENANCE',
    name: 'General Maintenance',
    description: 'Inspeksi unit dan perbaikan minor umum.',
  },
];

export const STARTER_PACK_SERVICES: readonly StarterPackService[] = [
  // AC & Ventilasi
  {
    code: 'CUCI_AC_SPLIT',
    name: 'Cuci AC Split',
    description: 'Pembersihan mendalam unit AC split type.',
    categoryCode: 'AC_VENTILASI',
  },
  {
    code: 'PERBAIKAN_AC_TIDAK_DINGIN',
    name: 'Perbaikan AC Tidak Dingin',
    description: 'Diagnosis dan perbaikan AC yang tidak mendingin.',
    categoryCode: 'AC_VENTILASI',
  },
  {
    code: 'PEMERIKSAAN_KEBOCORAN_AC',
    name: 'Pemeriksaan Kebocoran AC',
    description: 'Pemeriksaan dan penanganan kebocoran pada unit AC.',
    categoryCode: 'AC_VENTILASI',
  },
  // Listrik
  {
    code: 'PERBAIKAN_STOPKONTAK_SAKLAR',
    name: 'Perbaikan Stopkontak/Saklar',
    description: 'Perbaikan stopkontak dan saklar yang rusak.',
    categoryCode: 'LISTRIK',
  },
  {
    code: 'PEMASANGAN_LAMPU',
    name: 'Pemasangan Lampu',
    description: 'Pemasangan lampu dan fitting baru.',
    categoryCode: 'LISTRIK',
  },
  {
    code: 'PEMERIKSAAN_MCB_TRIP',
    name: 'Pemeriksaan MCB Trip',
    description: 'Pemeriksaan penyebab MCB sering trip.',
    categoryCode: 'LISTRIK',
  },
  // Plumbing
  {
    code: 'PERBAIKAN_KERAN_BOCOR',
    name: 'Perbaikan Keran Bocor',
    description: 'Perbaikan keran yang mengalami kebocoran.',
    categoryCode: 'PLUMBING',
  },
  {
    code: 'PERBAIKAN_PIPA_BOCOR',
    name: 'Perbaikan Pipa Bocor',
    description: 'Perbaikan pipa air yang bocor.',
    categoryCode: 'PLUMBING',
  },
  {
    code: 'SALURAN_AIR_TERSUMBAT',
    name: 'Saluran Air Tersumbat',
    description: 'Penanganan saluran air yang tersumbat.',
    categoryCode: 'PLUMBING',
  },
  // Sanitasi
  {
    code: 'PERBAIKAN_KLOSET',
    name: 'Perbaikan Kloset',
    description: 'Perbaikan kloset yang rusak atau bocor.',
    categoryCode: 'SANITASI',
  },
  {
    code: 'PERBAIKAN_SHOWER',
    name: 'Perbaikan Shower',
    description: 'Perbaikan shower dan kepala shower.',
    categoryCode: 'SANITASI',
  },
  {
    code: 'PERBAIKAN_WASTAFEL',
    name: 'Perbaikan Wastafel',
    description: 'Perbaikan wastafel dan salurannya.',
    categoryCode: 'SANITASI',
  },
  // Pintu & Kunci
  {
    code: 'PERBAIKAN_KUNCI_PINTU',
    name: 'Perbaikan Kunci Pintu',
    description: 'Perbaikan kunci pintu yang macet atau rusak.',
    categoryCode: 'PINTU_KUNCI',
  },
  {
    code: 'PENYETUAIAN_ENGSEL_PINTU',
    name: 'Penetelan Engsel/Pintu',
    description: 'Penetelan engsel dan pintu yang tidak rata.',
    categoryCode: 'PINTU_KUNCI',
  },
  {
    code: 'PENGGANTIAN_HANDLE',
    name: 'Penggantian Handle',
    description: 'Penggantian handle pintu atau laci.',
    categoryCode: 'PINTU_KUNCI',
  },
  // Interior
  {
    code: 'PERBAIKAN_PLAFON',
    name: 'Perbaikan Plafon',
    description: 'Perbaikan plafon yang rusak atau retak.',
    categoryCode: 'INTERIOR',
  },
  {
    code: 'PERBAIKAN_DINDING',
    name: 'Perbaikan Dinding',
    description: 'Perbaikan dinding yang rusak.',
    categoryCode: 'INTERIOR',
  },
  {
    code: 'PENGECATAN_MINOR',
    name: 'Pengecatan Minor',
    description: 'Pengecatan minor pada area kecil.',
    categoryCode: 'INTERIOR',
  },
  // Furniture
  {
    code: 'PERBAIKAN_LEMARI_KABINET',
    name: 'Perbaikan Lemari/Kabinet',
    description: 'Perbaikan lemari atau kabinet.',
    categoryCode: 'FURNITURE',
  },
  {
    code: 'PERBAIKAN_LACI_ENGSEL',
    name: 'Perbaikan Laci/Engsel',
    description: 'Perbaikan laci dan engsel furniture.',
    categoryCode: 'FURNITURE',
  },
  {
    code: 'PEMASANGAN_RAK',
    name: 'Pemasangan Rak',
    description: 'Pemasangan rak dinding atau rak standing.',
    categoryCode: 'FURNITURE',
  },
  // General Maintenance
  {
    code: 'INSPEKSI_KERUSAKAN_UNIT',
    name: 'Inspeksi Kerusakan Unit',
    description: 'Inspeksi kerusakan unit hunian secara menyeluruh.',
    categoryCode: 'GENERAL_MAINTENANCE',
  },
  {
    code: 'PERBAIKAN_MINOR_UMUM',
    name: 'Perbaikan Minor Umum',
    description: 'Perbaikan minor umum pada unit hunian.',
    categoryCode: 'GENERAL_MAINTENANCE',
  },
  {
    code: 'KUNJUNGAN_DIAGNOSIS_TEKNISI',
    name: 'Kunjungan Diagnosis Teknisi',
    description: 'Kunjungan teknisi untuk diagnosis kerusakan.',
    categoryCode: 'GENERAL_MAINTENANCE',
  },
];

export function starterPackCategoryCodes(): string[] {
  return STARTER_PACK_CATEGORIES.map((category) => category.code);
}
