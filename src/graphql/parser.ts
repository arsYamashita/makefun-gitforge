// A small GraphQL lexer and parser: executable documents only (operations and fragments).

export interface Loc {
  line: number;
  column: number;
}

export class GraphQLSyntaxError extends Error {
  readonly locations: Loc[];
  constructor(message: string, loc: Loc) {
    super(message);
    this.locations = [loc];
  }
}

export type TypeNode =
  | { kind: 'Named'; name: string }
  | { kind: 'List'; of: TypeNode }
  | { kind: 'NonNull'; of: TypeNode };

export type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: { name: string; value: ValueNode }[] };

export interface ArgumentNode {
  name: string;
  value: ValueNode;
}

export interface DirectiveNode {
  name: string;
  args: ArgumentNode[];
}

export interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: ArgumentNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
  loc: Loc;
}

export interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
  directives: DirectiveNode[];
  loc: Loc;
}

export interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
  loc: Loc;
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface VariableDefinitionNode {
  name: string;
  type: TypeNode;
  defaultValue: ValueNode | null;
}

export interface OperationNode {
  kind: 'Operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDefinitionNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
  loc: Loc;
}

export interface FragmentNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
  loc: Loc;
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

type TokenKind = 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

function isNameStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function dedentBlock(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let common = Infinity;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    if (indent < line.length && indent < common) common = indent;
  }
  if (common !== Infinity) {
    for (let i = 1; i < lines.length; i += 1) lines[i] = lines[i].slice(common);
  }
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = source.length;
  const loc = (at: number): Loc => ({ line, column: at - lineStart + 1 });
  const bad = (message: string, at: number): never => {
    throw new GraphQLSyntaxError(`Syntax Error: ${message}`, loc(at));
  };
  while (i < n) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      i += 1;
      line += 1;
      lineStart = i;
      continue;
    }
    if (c === '\r') {
      i += 1;
      if (source[i] === '\n') i += 1;
      line += 1;
      lineStart = i;
      continue;
    }
    if (c === '#') {
      while (i < n && source[i] !== '\n' && source[i] !== '\r') i += 1;
      continue;
    }
    const column = i - lineStart + 1;
    if (c === '.') {
      if (source.startsWith('...', i)) {
        tokens.push({ kind: 'punct', value: '...', line, column });
        i += 3;
        continue;
      }
      bad('Unexpected character: ".".', i);
    }
    if (PUNCT.has(c)) {
      tokens.push({ kind: 'punct', value: c, line, column });
      i += 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < n && (isNameStart(source[j]) || isDigit(source[j]))) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j), line, column });
      i = j;
      continue;
    }
    if (c === '-' || isDigit(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      if (!isDigit(source[j] ?? '')) bad(`Invalid number, expected digit but got: ${JSON.stringify(source[j] ?? '<EOF>')}.`, j);
      if (source[j] === '0' && isDigit(source[j + 1] ?? '')) bad('Invalid number, unexpected digit after 0.', j + 1);
      while (isDigit(source[j] ?? '')) j += 1;
      let kind: TokenKind = 'int';
      if (source[j] === '.') {
        kind = 'float';
        j += 1;
        if (!isDigit(source[j] ?? '')) bad('Invalid number, expected digit after ".".', j);
        while (isDigit(source[j] ?? '')) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        kind = 'float';
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        if (!isDigit(source[j] ?? '')) bad('Invalid number, expected digit after exponent.', j);
        while (isDigit(source[j] ?? '')) j += 1;
      }
      tokens.push({ kind, value: source.slice(i, j), line, column });
      i = j;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        let j = i + 3;
        let raw = '';
        let closed = false;
        const startLine = line;
        const startColumn = column;
        while (j < n) {
          if (source.startsWith('"""', j)) {
            closed = true;
            j += 3;
            break;
          }
          if (source.startsWith('\\"""', j)) {
            raw += '"""';
            j += 4;
            continue;
          }
          const ch = source[j];
          if (ch === '\n') {
            line += 1;
            lineStart = j + 1;
          }
          raw += ch;
          j += 1;
        }
        if (!closed) bad('Unterminated string.', i);
        tokens.push({ kind: 'string', value: dedentBlock(raw), line: startLine, column: startColumn });
        i = j;
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < n) {
        const ch = source[j];
        if (ch === '"') {
          closed = true;
          j += 1;
          break;
        }
        if (ch === '\n' || ch === '\r') break;
        if (ch === '\\') {
          const e = source[j + 1];
          j += 2;
          if (e === 'n') value += '\n';
          else if (e === 't') value += '\t';
          else if (e === 'r') value += '\r';
          else if (e === 'b') value += '\b';
          else if (e === 'f') value += '\f';
          else if (e === '"' || e === '\\' || e === '/') value += e;
          else if (e === 'u') {
            const hex = source.slice(j, j + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) bad('Invalid Unicode escape sequence.', j - 2);
            value += String.fromCharCode(parseInt(hex, 16));
            j += 4;
          } else bad(`Invalid character escape sequence: "\\${e ?? ''}".`, j - 2);
          continue;
        }
        value += ch;
        j += 1;
      }
      if (!closed) bad('Unterminated string.', i);
      tokens.push({ kind: 'string', value, line, column });
      i = j;
      continue;
    }
    bad(`Unexpected character: ${JSON.stringify(c)}.`, i);
  }
  tokens.push({ kind: 'eof', value: '<EOF>', line, column: n - lineStart + 1 });
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private get tok(): Token {
    return this.tokens[this.pos];
  }

  private loc(): Loc {
    return { line: this.tok.line, column: this.tok.column };
  }

  private fail(expected: string): never {
    const t = this.tok;
    const got = t.kind === 'eof' ? '<EOF>' : `"${t.value}"`;
    throw new GraphQLSyntaxError(`Syntax Error: Expected ${expected}, found ${got}.`, { line: t.line, column: t.column });
  }

  private isPunct(value: string): boolean {
    return this.tok.kind === 'punct' && this.tok.value === value;
  }

  private isName(value?: string): boolean {
    return this.tok.kind === 'name' && (value === undefined || this.tok.value === value);
  }

  private expectPunct(value: string): void {
    if (!this.isPunct(value)) this.fail(`"${value}"`);
    this.pos += 1;
  }

  private expectName(): string {
    if (this.tok.kind !== 'name') this.fail('Name');
    const v = this.tok.value;
    this.pos += 1;
    return v;
  }

  private expectKeyword(word: string): void {
    if (!this.isName(word)) this.fail(`"${word}"`);
    this.pos += 1;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    if (this.tok.kind === 'eof') this.fail('Document');
    while (this.tok.kind !== 'eof') {
      if (this.isPunct('{')) {
        const loc = this.loc();
        operations.push({ kind: 'Operation', operation: 'query', name: null, variables: [], directives: [], selectionSet: this.selectionSet(), loc });
      } else if (this.isName('query') || this.isName('mutation') || this.isName('subscription')) {
        operations.push(this.operation());
      } else if (this.isName('fragment')) {
        const f = this.fragment();
        if (fragments.has(f.name)) throw new GraphQLSyntaxError(`There can be only one fragment named "${f.name}".`, f.loc);
        fragments.set(f.name, f);
      } else this.fail('executable definition');
    }
    return { operations, fragments };
  }

  private operation(): OperationNode {
    const loc = this.loc();
    const operation = this.expectName() as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    if (this.tok.kind === 'name') name = this.expectName();
    const variables: VariableDefinitionNode[] = [];
    if (this.isPunct('(')) {
      this.pos += 1;
      while (!this.isPunct(')')) {
        this.expectPunct('$');
        const vname = this.expectName();
        this.expectPunct(':');
        const type = this.type();
        let defaultValue: ValueNode | null = null;
        if (this.isPunct('=')) {
          this.pos += 1;
          defaultValue = this.value(true);
        }
        this.directives();
        variables.push({ name: vname, type, defaultValue });
      }
      this.pos += 1;
    }
    const directives = this.directives();
    return { kind: 'Operation', operation, name, variables, directives, selectionSet: this.selectionSet(), loc };
  }

  private fragment(): FragmentNode {
    const loc = this.loc();
    this.expectKeyword('fragment');
    const name = this.expectName();
    if (name === 'on') this.fail('fragment name');
    this.expectKeyword('on');
    const typeCondition = this.expectName();
    const directives = this.directives();
    return { kind: 'Fragment', name, typeCondition, directives, selectionSet: this.selectionSet(), loc };
  }

  private selectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.isPunct('}')) out.push(this.selection());
    this.pos += 1;
    if (out.length === 0) this.fail('Name');
    return out;
  }

  private selection(): SelectionNode {
    const loc = this.loc();
    if (this.isPunct('...')) {
      this.pos += 1;
      if (this.isName() && !this.isName('on')) {
        const name = this.expectName();
        return { kind: 'FragmentSpread', name, directives: this.directives(), loc };
      }
      let typeCondition: string | null = null;
      if (this.isName('on')) {
        this.pos += 1;
        typeCondition = this.expectName();
      }
      const directives = this.directives();
      return { kind: 'InlineFragment', typeCondition, directives, selectionSet: this.selectionSet(), loc };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.isPunct(':')) {
      this.pos += 1;
      alias = name;
      name = this.expectName();
    }
    const args = this.args(false);
    const directives = this.directives();
    const selectionSet = this.isPunct('{') ? this.selectionSet() : null;
    return { kind: 'Field', alias, name, args, directives, selectionSet, loc };
  }

  private args(isConst: boolean): ArgumentNode[] {
    const out: ArgumentNode[] = [];
    if (!this.isPunct('(')) return out;
    this.pos += 1;
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.value(isConst) });
    }
    this.pos += 1;
    return out;
  }

  private directives(): DirectiveNode[] {
    const out: DirectiveNode[] = [];
    while (this.isPunct('@')) {
      this.pos += 1;
      out.push({ name: this.expectName(), args: this.args(false) });
    }
    return out;
  }

  private type(): TypeNode {
    let node: TypeNode;
    if (this.isPunct('[')) {
      this.pos += 1;
      node = { kind: 'List', of: this.type() };
      this.expectPunct(']');
    } else node = { kind: 'Named', name: this.expectName() };
    if (this.isPunct('!')) {
      this.pos += 1;
      node = { kind: 'NonNull', of: node };
    }
    return node;
  }

  private value(isConst: boolean): ValueNode {
    const t = this.tok;
    if (t.kind === 'punct') {
      if (t.value === '$') {
        if (isConst) this.fail('a constant value');
        this.pos += 1;
        return { kind: 'Variable', name: this.expectName() };
      }
      if (t.value === '[') {
        this.pos += 1;
        const values: ValueNode[] = [];
        while (!this.isPunct(']')) values.push(this.value(isConst));
        this.pos += 1;
        return { kind: 'List', values };
      }
      if (t.value === '{') {
        this.pos += 1;
        const fields: { name: string; value: ValueNode }[] = [];
        while (!this.isPunct('}')) {
          const name = this.expectName();
          this.expectPunct(':');
          fields.push({ name, value: this.value(isConst) });
        }
        this.pos += 1;
        return { kind: 'Object', fields };
      }
      this.fail('a value');
    }
    this.pos += 1;
    if (t.kind === 'int') return { kind: 'Int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'Float', value: Number(t.value) };
    if (t.kind === 'string') return { kind: 'String', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'Boolean', value: true };
      if (t.value === 'false') return { kind: 'Boolean', value: false };
      if (t.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: t.value };
    }
    this.pos -= 1;
    return this.fail('a value');
  }
}

export function parse(source: string): DocumentNode {
  return new Parser(source).parseDocument();
}
