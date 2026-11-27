import React from 'react';

// One geometry set for the whole product, kept as real SVG files in src/icons so the same
// artwork can be opened in a vector editor, printed and reused outside the app. The files are
// inlined by the build, so `currentColor` still lets every screen tint its own icons.
import { ReactComponent as Overview } from '../icons/overview.svg';
import { ReactComponent as Projects } from '../icons/projects.svg';
import { ReactComponent as Map } from '../icons/map.svg';
import { ReactComponent as Cube } from '../icons/cube.svg';
import { ReactComponent as Compass } from '../icons/compass.svg';
import { ReactComponent as Clipboard } from '../icons/clipboard.svg';
import { ReactComponent as Calculator } from '../icons/calculator.svg';
import { ReactComponent as Chart } from '../icons/chart.svg';
import { ReactComponent as Shield } from '../icons/shield.svg';
import { ReactComponent as Box } from '../icons/box.svg';
import { ReactComponent as Upload } from '../icons/upload.svg';
import { ReactComponent as Download } from '../icons/download.svg';
import { ReactComponent as Team } from '../icons/team.svg';
import { ReactComponent as Receipt } from '../icons/receipt.svg';
import { ReactComponent as Key } from '../icons/key.svg';
import { ReactComponent as File } from '../icons/file.svg';
import { ReactComponent as Building } from '../icons/building.svg';
import { ReactComponent as Activity } from '../icons/activity.svg';
import { ReactComponent as Alert } from '../icons/alert.svg';
import { ReactComponent as ArrowRight } from '../icons/arrowRight.svg';
import { ReactComponent as ArrowUpRight } from '../icons/arrowUpRight.svg';
import { ReactComponent as Bell } from '../icons/bell.svg';
import { ReactComponent as Buffer } from '../icons/buffer.svg';
import { ReactComponent as Camera } from '../icons/camera.svg';
import { ReactComponent as Check } from '../icons/check.svg';
import { ReactComponent as CheckCircle } from '../icons/checkCircle.svg';
import { ReactComponent as ChevronDown } from '../icons/chevronDown.svg';
import { ReactComponent as ChevronLeft } from '../icons/chevronLeft.svg';
import { ReactComponent as ChevronRight } from '../icons/chevronRight.svg';
import { ReactComponent as Clash } from '../icons/clash.svg';
import { ReactComponent as Clock } from '../icons/clock.svg';
import { ReactComponent as Command } from '../icons/command.svg';
import { ReactComponent as Cursor } from '../icons/cursor.svg';
import { ReactComponent as CutFill } from '../icons/cutfill.svg';
import { ReactComponent as Database } from '../icons/database.svg';
import { ReactComponent as Georef } from '../icons/georef.svg';
import { ReactComponent as Globe } from '../icons/globe.svg';
import { ReactComponent as Help } from '../icons/help.svg';
import { ReactComponent as Layers } from '../icons/layers.svg';
import { ReactComponent as Locate } from '../icons/locate.svg';
import { ReactComponent as Logout } from '../icons/logout.svg';
import { ReactComponent as MapPin } from '../icons/mapPin.svg';
import { ReactComponent as Maximize } from '../icons/maximize.svg';
import { ReactComponent as Menu } from '../icons/menu.svg';
import { ReactComponent as Mfa } from '../icons/mfa.svg';
import { ReactComponent as Minus } from '../icons/minus.svg';
import { ReactComponent as Moon } from '../icons/moon.svg';
import { ReactComponent as Mountain } from '../icons/mountain.svg';
import { ReactComponent as Panel } from '../icons/panel.svg';
import { ReactComponent as Pan } from '../icons/pan.svg';
import { ReactComponent as Pen } from '../icons/pen.svg';
import { ReactComponent as Plus } from '../icons/plus.svg';
import { ReactComponent as Print } from '../icons/print.svg';
import { ReactComponent as Refresh } from '../icons/refresh.svg';
import { ReactComponent as Route } from '../icons/route.svg';
import { ReactComponent as Ruler } from '../icons/ruler.svg';
import { ReactComponent as Satellite } from '../icons/satellite.svg';
import { ReactComponent as Save } from '../icons/save.svg';
import { ReactComponent as Scissors } from '../icons/scissors.svg';
import { ReactComponent as Search } from '../icons/search.svg';
import { ReactComponent as Settings } from '../icons/settings.svg';
import { ReactComponent as Slope } from '../icons/slope.svg';
import { ReactComponent as Sparkles } from '../icons/sparkles.svg';
import { ReactComponent as Sun } from '../icons/sun.svg';
import { ReactComponent as Sync } from '../icons/sync.svg';
import { ReactComponent as Table } from '../icons/table.svg';
import { ReactComponent as TabBim } from '../icons/tab-bim.svg';
import { ReactComponent as Target } from '../icons/target.svg';
import { ReactComponent as TabControl } from '../icons/tab-control.svg';
import { ReactComponent as TabGis } from '../icons/tab-gis.svg';
import { ReactComponent as TabReports } from '../icons/tab-reports.svg';
import { ReactComponent as TabTerrain } from '../icons/tab-terrain.svg';
import { ReactComponent as TileAssurance } from '../icons/tile-assurance.svg';
import { ReactComponent as TileBim } from '../icons/tile-bim.svg';
import { ReactComponent as TileCost } from '../icons/tile-cost.svg';
import { ReactComponent as TileMap } from '../icons/tile-map.svg';
import { ReactComponent as TileTerrain } from '../icons/tile-terrain.svg';
import { ReactComponent as User } from '../icons/user.svg';
import { ReactComponent as Wifi } from '../icons/wifi.svg';
import { ReactComponent as X } from '../icons/x.svg';

const ICONS = {
  overview: Overview,
  projects: Projects,
  map: Map,
  cube: Cube,
  compass: Compass,
  clipboard: Clipboard,
  calculator: Calculator,
  chart: Chart,
  shield: Shield,
  box: Box,
  upload: Upload,
  download: Download,
  team: Team,
  receipt: Receipt,
  key: Key,
  file: File,
  building: Building,
  activity: Activity,
  alert: Alert,
  arrowRight: ArrowRight,
  arrowUpRight: ArrowUpRight,
  bell: Bell,
  buffer: Buffer,
  camera: Camera,
  check: Check,
  checkCircle: CheckCircle,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  clash: Clash,
  clock: Clock,
  command: Command,
  cursor: Cursor,
  cutfill: CutFill,
  database: Database,
  georef: Georef,
  globe: Globe,
  help: Help,
  layers: Layers,
  locate: Locate,
  logout: Logout,
  mapPin: MapPin,
  maximize: Maximize,
  menu: Menu,
  mfa: Mfa,
  minus: Minus,
  moon: Moon,
  mountain: Mountain,
  panel: Panel,
  pan: Pan,
  pen: Pen,
  plus: Plus,
  print: Print,
  refresh: Refresh,
  route: Route,
  ruler: Ruler,
  satellite: Satellite,
  save: Save,
  scissors: Scissors,
  search: Search,
  settings: Settings,
  slope: Slope,
  sparkles: Sparkles,
  sun: Sun,
  sync: Sync,
  table: Table,
  target: Target,
  'tab-bim': TabBim,
  'tab-control': TabControl,
  'tab-gis': TabGis,
  'tab-reports': TabReports,
  'tab-terrain': TabTerrain,
  'tile-assurance': TileAssurance,
  'tile-bim': TileBim,
  'tile-cost': TileCost,
  'tile-map': TileMap,
  'tile-terrain': TileTerrain,
  user: User,
  wifi: Wifi,
  x: X
};

export default function Icon({ name, size = 16, strokeWidth = 2.2, className = '', ...rest }) {
  const Glyph = ICONS[name] || Overview;
  return (
    <Glyph
      width={size}
      height={size}
      strokeWidth={strokeWidth}
      className={className}
      aria-hidden="true"
      focusable="false"
      {...rest}
    />
  );
}
