import * as vscode from 'vscode';
import { HTTP_METHODS, parseHttpFile, type ParsedRequest } from '../core/parser.js';
import { parseGrpcFile, type ParsedGrpcRequestWithRange } from '../core/grpc.js';

/**
 * Tree view backing "Reqit Requests".
 *
 * Scope: `.requests/` (recursive) under the first workspace folder.
 * Grouping: subfolders are folder nodes, `.http` files are file nodes, each
 * file expands into its parsed requests (using `### name` when present).
 */
export const REQUEST_NAME_SEARCH_MAX_LENGTH = 128;

export class RequestsTreeProvider implements vscode.TreeDataProvider<RequestsNode> {
  private readonly _onDidChange = new vscode.EventEmitter<RequestsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  // Presentation-only filters: never persisted, and never resolve secrets.
  private methodFilter: string | undefined;
  private nameSearchFilter: string | undefined;
  private urlSearchFilter: string | undefined;

  hasUrlSearchFilter(): boolean {
    return this.urlSearchFilter !== undefined;
  }

  setUrlFilter(query: unknown): boolean {
    if (query !== undefined && typeof query !== 'string') return false;
    if (typeof query === 'string' && query.length > REQUEST_NAME_SEARCH_MAX_LENGTH) return false;
    const normalized = query === undefined || query.length === 0 ? undefined : query.toLowerCase();
    if (this.urlSearchFilter === normalized) return false;
    this.urlSearchFilter = normalized;
    this.refresh();
    return true;
  }

  setMethodFilter(method: unknown): boolean {
    if (
      method !== undefined &&
      (typeof method !== 'string' ||
        !(method === 'GRPC' || HTTP_METHODS.some((allowed) => allowed === method)))
    )
      return false;
    if (this.methodFilter === method) return false;
    this.methodFilter = method;
    this.refresh();
    return true;
  }

  getMethodFilter(): string | undefined {
    return this.methodFilter;
  }

  hasNameSearchFilter(): boolean {
    return this.nameSearchFilter !== undefined;
  }

  setNameFilter(query: unknown): boolean {
    if (query !== undefined && typeof query !== 'string') return false;
    if (typeof query === 'string' && query.length > REQUEST_NAME_SEARCH_MAX_LENGTH) return false;

    const normalized =
      query === undefined || query.length === 0 ? undefined : query.toLocaleLowerCase();
    if (this.nameSearchFilter === normalized) return false;
    this.nameSearchFilter = normalized;
    this.refresh();
    return true;
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(node: RequestsNode): vscode.TreeItem {
    return node.toTreeItem();
  }

  async getChildren(node?: RequestsNode): Promise<RequestsNode[]> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return [];
    const root = vscode.Uri.joinPath(folder.uri, '.requests');

    if (!node) {
      if (!(await dirExists(root))) {
        return [new MessageNode('Run "Reqit: Init Workspace" to create .requests/')];
      }
      return listDir(root);
    }
    if (node.kind === 'folder') {
      return listDir(node.uri);
    }
    if (node.kind === 'file') {
      const requests = await parseFileRequests(node.uri);
      // Read current filters AFTER I/O so a late read cannot restore obsolete
      // selections. Do not renumber nodes: their send anchors survive.
      const methodFilter = this.methodFilter;
      const nameSearchFilter = this.nameSearchFilter;
      const urlSearchFilter = this.urlSearchFilter;
      const filtered = requests.filter(
        (request) =>
          matchesMethodFilter(request, methodFilter) &&
          matchesNameFilter(request, nameSearchFilter) &&
          (urlSearchFilter === undefined ||
            (request.kind === 'request' &&
              request.request.url.toLowerCase().includes(urlSearchFilter))),
      );
      return requests.length > 0 && filtered.length === 0
        ? [new MessageNode(noMatchMessage(methodFilter, nameSearchFilter, urlSearchFilter))]
        : filtered;
    }
    return [];
  }
}

function matchesMethodFilter(request: RequestsNode, methodFilter: string | undefined): boolean {
  return (
    methodFilter === undefined ||
    (request.kind === 'request' && request.request.method === methodFilter) ||
    (request.kind === 'grpc-request' && methodFilter === 'GRPC')
  );
}

function matchesNameFilter(request: RequestsNode, nameSearchFilter: string | undefined): boolean {
  if (nameSearchFilter === undefined) return true;
  if (request.kind === 'request') {
    return request.request.name?.toLocaleLowerCase().includes(nameSearchFilter) ?? false;
  }
  if (request.kind === 'grpc-request') {
    return request.request.name?.toLocaleLowerCase().includes(nameSearchFilter) ?? false;
  }
  return false;
}

function noMatchMessage(
  methodFilter: string | undefined,
  nameSearchFilter: string | undefined,
  urlSearchFilter: string | undefined,
): string {
  if ([methodFilter, nameSearchFilter, urlSearchFilter].filter((v) => v !== undefined).length > 1) {
    return 'No requests match current filters';
  }
  if (nameSearchFilter !== undefined) {
    return 'No requests match the active name search';
  }
  if (urlSearchFilter !== undefined) {
    return 'No requests match the active URL search';
  }
  return 'No requests match the method filter';
}

async function dirExists(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

async function listDir(uri: vscode.Uri): Promise<RequestsNode[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return [];
  }
  const out: RequestsNode[] = [];
  for (const [name, type] of entries) {
    const child = vscode.Uri.joinPath(uri, name);
    if (type & vscode.FileType.Directory) {
      out.push(new FolderNode(name, child));
    } else if ((type & vscode.FileType.File) !== 0 && /\.(http|grpc)$/i.test(name)) {
      out.push(new FileNode(name, child));
    }
  }
  // Folders first, then files, both alpha.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

async function parseFileRequests(uri: vscode.Uri): Promise<RequestsNode[]> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return [];
  }
  const text = new TextDecoder().decode(bytes);
  if (/\.grpc$/i.test(uri.path)) {
    const { requests } = parseGrpcFile(text);
    return requests.map((r, i) => new GrpcRequestNode(uri, r, i));
  }
  const { requests } = parseHttpFile(text);
  return requests.map((r, i) => new RequestNode(uri, r, i));
}

export type RequestsNode = FolderNode | FileNode | RequestNode | GrpcRequestNode | MessageNode;

class FolderNode {
  readonly kind = 'folder' as const;
  constructor(
    readonly label: string,
    readonly uri: vscode.Uri,
  ) {}
  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.resourceUri = this.uri;
    item.iconPath = vscode.ThemeIcon.Folder;
    item.contextValue = 'reqit.folder';
    return item;
  }
}

class FileNode {
  readonly kind = 'file' as const;
  constructor(
    readonly label: string,
    readonly uri: vscode.Uri,
  ) {}
  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.resourceUri = this.uri;
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = 'reqit.file';
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [this.uri],
    };
    return item;
  }
}

class RequestNode {
  readonly kind = 'request' as const;
  readonly label: string;
  constructor(
    readonly uri: vscode.Uri,
    readonly request: ParsedRequest,
    readonly index: number,
  ) {
    this.label = request.name ?? `${request.method} ${shortUrl(request.url)}`;
  }
  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    item.description = `${this.request.method}`;
    item.tooltip = `${this.request.method} ${this.request.url}`;
    item.iconPath = new vscode.ThemeIcon('symbol-event');
    item.contextValue = 'reqit.request';
    item.command = {
      command: 'reqit.sendRequest',
      title: '▶ Send Request',
      arguments: [
        {
          documentUri: this.uri.toString(),
          requestLineIndex: this.request.requestLineIndex,
        },
      ],
    };
    return item;
  }
}

class MessageNode {
  readonly kind = 'message' as const;
  readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'reqit.message';
    return item;
  }
}

class GrpcRequestNode {
  readonly kind = 'grpc-request' as const;
  readonly label: string;
  constructor(
    readonly uri: vscode.Uri,
    readonly request: ParsedGrpcRequestWithRange,
    readonly index: number,
  ) {
    const t = request.target;
    this.label = request.name ?? `${t.host}/${t.service}/${t.method}`;
  }
  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    item.description = 'GRPC';
    const t = this.request.target;
    item.tooltip = `GRPC ${t.host}:${t.port}/${t.service}/${t.method}`;
    item.iconPath = new vscode.ThemeIcon('symbol-event');
    item.contextValue = 'reqit.grpcRequest';
    item.command = {
      command: 'reqit.sendGrpcRequest',
      title: '▶ Send Request',
      arguments: [
        {
          documentUri: this.uri.toString(),
          requestLineIndex: this.request.requestLineIndex,
        },
      ],
    };
    return item;
  }
}

function shortUrl(url: string): string {
  if (url.length <= 60) return url;
  return url.slice(0, 57) + '...';
}
