// Free Polyfork low-poly meshes, self-hosted under CC BY 4.0.
// Attribution and the original model pages accompany the files in credits.html.
const asset = (id: string, label: string) => ({
  url: `/models/polyfork/${id}.glb`,
  source: `https://polyfork.dev/asset/${id}`,
  label,
});

export const WORLD_ASSETS = {
  studio: asset('porch-front-cottage-620c29', 'Porch-Front Cottage'),
  tree: asset('ornamental-front-yard-tree-c6781a', 'Ornamental Front-Yard Tree'),
  lamp: asset('street-lamp-b4fa26', 'Street-lamp'),
  bench: asset('park-bench-dc8b62', 'Park Bench'),
  fountain: asset('campus-plaza-fountain-a0cab1', 'Campus Plaza Fountain'),
  plant: asset('potted-shrub-43bd21', 'Potted Shrub'),
  bookshelf: asset('bookshelf-5e881a', 'Bookshelf'),
  cabin: asset('log-cabin-4fac3b', 'Log Cabin'),
  shed: asset('backyard-garden-shed-38d79f', 'Backyard Garden Shed'),
  tent: asset('welcome-week-tent-stall-c27020', 'Welcome Week Tent Stall'),
  fence: asset('split-rail-fence-run-87da39', 'Split-Rail Fence Run'),
  rock: asset('garden-rock-7f5d60', 'Garden Rock'),
  flowerbox: asset('flower-planter-550bfb', 'Flower Planter'),
  pine: asset('young-pine-0d7695', 'Young Pine'),
  picnic: asset('campsite-picnic-table-361d51', 'Campsite Picnic Table'),
  chair: asset('folding-camp-chair-2fc7d1', 'Folding Camp Chair'),
  barrel: asset('barrel-aadc94', 'Barrel'),
  crate: asset('wooden-crate-e46521', 'Wooden Crate'),
  signpost: asset('signpost-0bf523', 'Signpost'),
  well: asset('stone-well-2b4717', 'Stone Well'),
} as const;

export type WorldAssetId = keyof typeof WORLD_ASSETS;
export const WORLD_CORE_ASSETS = ['studio', 'tree', 'lamp', 'bench', 'fountain', 'plant', 'bookshelf'] as const;
export const WORLD_ASSET_CREDITS = '/models/polyfork/credits.html';
