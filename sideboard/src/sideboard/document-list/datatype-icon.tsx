import {
  Activity,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRightLeft,
  ArrowUpDown,
  Backpack,
  BookOpen,
  Box,
  Cable,
  Calendar,
  Cat,
  ChartSpline,
  CheckSquare,
  CheckSquare2,
  CircleDot,
  CirclePlus,
  CircuitBoard,
  Clapperboard,
  ClipboardList,
  Clock,
  Cpu,
  Crosshair,
  Database,
  Dices,
  Dumbbell,
  Edit,
  Eraser,
  Eye,
  File,
  FileEdit,
  FilePlus,
  FileText,
  Film,
  Folder,
  FolderOpen,
  GitBranch,
  Glasses,
  Grid3x3,
  Hash,
  History,
  Home,
  Kanban,
  Key,
  Layers,
  Layout,
  LayoutGrid,
  Library,
  List,
  ListChecks,
  ListTodo,
  MessageCircle,
  MessageSquare,
  Move,
  Music,
  Notebook,
  Paintbrush,
  Palette,
  PenLine,
  Play,
  Plus,
  Repeat,
  Search,
  Settings,
  Sheet,
  ShieldCheck,
  Shuffle,
  Sigma,
  Sparkles,
  Square,
  Tag,
  Target,
  Trash,
  Trash2,
  TrendingUp,
  User,
  UserCircle,
  Users,
  Video,
  Wifi,
  Zap,
  type LucideIcon,
} from "lucide-solid";
import { Dynamic } from "solid-js/web";
import { useDatatypeDescription, type MaybeAccessor } from "../lib/solid-plugins.ts";

// A curated subset of lucide icons, covering every `icon` currently declared
// by datatypes/tools across patchwork-base and patchwork-tools (plus a
// generic fallback). Named imports keep this tree-shakeable — unlike
// `import * as icons from "lucide-solid"`, which pulls all ~1500 icons into
// the bundle. Datatypes with an icon name outside this set (new, third-party,
// or renamed upstream) just render the fallback rather than failing.
const KNOWN_ICONS: Record<string, LucideIcon> = {
  Activity,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRightLeft,
  ArrowUpDown,
  Backpack,
  BookOpen,
  Box,
  Cable,
  Calendar,
  Cat,
  ChartSpline,
  CheckSquare,
  CheckSquare2,
  CircleDot,
  CirclePlus,
  CircuitBoard,
  Clapperboard,
  ClipboardList,
  Clock,
  Cpu,
  Crosshair,
  Database,
  Dices,
  Dumbbell,
  Edit,
  Eraser,
  Eye,
  File,
  FileEdit,
  FilePlus,
  FileText,
  Film,
  Folder,
  FolderOpen,
  GitBranch,
  Glasses,
  Grid3x3,
  Hash,
  History,
  Home,
  Kanban,
  Key,
  Layers,
  Layout,
  LayoutGrid,
  Library,
  List,
  ListChecks,
  ListTodo,
  MessageCircle,
  MessageSquare,
  Move,
  Music,
  Notebook,
  Paintbrush,
  Palette,
  PenLine,
  Play,
  Plus,
  Repeat,
  Search,
  Settings,
  Sheet,
  ShieldCheck,
  Shuffle,
  Sigma,
  Sparkles,
  Square,
  Tag,
  Target,
  Trash,
  Trash2,
  TrendingUp,
  User,
  UserCircle,
  Users,
  Video,
  Wifi,
  Zap,
};

const FALLBACK_ICON = File;

function resolveIcon(name: string | undefined): LucideIcon {
  if (!name) return FALLBACK_ICON;
  return (
    KNOWN_ICONS[name] ??
    KNOWN_ICONS[name[0].toUpperCase() + name.slice(1)] ??
    FALLBACK_ICON
  );
}

/**
 * Renders the icon a document's datatype registered itself with (the
 * `icon` field of its `patchwork:datatype` plugin description, a lucide
 * icon name e.g. "FileText"). Falls back to a generic file icon for
 * datatypes with no icon, or an icon name outside our curated set.
 */
export function DatatypeIcon(props: { type: MaybeAccessor<string> }) {
  const datatype = useDatatypeDescription(props.type);
  const icon = () => resolveIcon(datatype()?.icon);

  return (
    <Dynamic
      component={icon()}
      class="document-list-item__icon"
      size={14}
      aria-hidden="true"
    />
  );
}
