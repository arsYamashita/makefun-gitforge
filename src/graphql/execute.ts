// Validation and execution of a parsed document against the schema in schema.ts.

import { HttpError } from '../http.ts';
import type { ArgumentNode, DirectiveNode, DocumentNode, FieldNode, FragmentNode, Loc, OperationNode, SelectionNode, TypeNode, ValueNode } from './parser.ts';
import { getType, implementors, isLeaf, namedType, parseTypeRef, typeApplies } from './schema.ts';
import type { FieldDef, TypeDef, TypeRef } from './schema.ts';

export interface ExecContext {
  /** The API origin used to build url fields. */
  origin: string;
}

export type Resolver = (source: any, args: Record<string, any>, ctx: ExecContext) => unknown;
export type ResolverMap = Record<string, Record<string, Resolver>>;

export interface GraphQLErrorEntry {
  message: string;
  locations?: Loc[];
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
  type?: string;
}

export interface ExecutionResult {
  data?: Record<string, unknown> | null;
  errors?: GraphQLErrorEntry[];
}

/** A resolver failure the field handler records as a GraphQL error. */
export class GraphQLFieldError extends Error {
  readonly extensions: Record<string, unknown> | undefined;
  readonly errorType: string | undefined;
  constructor(message: string, errorType?: string, extensions?: Record<string, unknown>) {
    super(message);
    this.errorType = errorType;
    this.extensions = extensions;
  }
}

class NullBubble extends Error {}

function typeNodeToRef(node: TypeNode): TypeRef {
  if (node.kind === 'Named') return { k: 'NAMED', name: node.name };
  if (node.kind === 'List') return { k: 'LIST', of: typeNodeToRef(node.of) };
  return { k: 'NON_NULL', of: typeNodeToRef(node.of) };
}

function typeRefToString(ref: TypeRef): string {
  if (ref.k === 'NAMED') return ref.name as string;
  if (ref.k === 'LIST') return `[${typeRefToString(ref.of as TypeRef)}]`;
  return `${typeRefToString(ref.of as TypeRef)}!`;
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function validateDocument(doc: DocumentNode, operation: OperationNode): GraphQLErrorEntry[] {
  const errors: GraphQLErrorEntry[] = [];
  const validatedFragments = new Set<string>();
  const stack: string[] = [];

  const rootName = operation.operation === 'mutation' ? 'Mutation' : operation.operation === 'query' ? 'Query' : null;
  if (rootName === null) {
    return [{ message: 'Subscriptions are not supported', locations: [operation.loc] }];
  }

  const checkSelections = (typeName: string, selections: SelectionNode[]): void => {
    const def = getType(typeName);
    if (def === undefined) return;
    for (const sel of selections) {
      if (sel.kind === 'Field') {
        if (sel.name === '__typename') {
          if (sel.selectionSet !== null) errors.push({ message: "Field '__typename' must not have a selection since type 'String!' has no subfields.", locations: [sel.loc] });
          continue;
        }
        const field = def.fields.get(sel.name);
        if (field === undefined) {
          errors.push({
            message: `Field '${sel.name}' doesn't exist on type '${typeName}'`,
            locations: [sel.loc],
            extensions: { code: 'undefinedField', typeName, fieldName: sel.name },
          });
          continue;
        }
        const known = new Set(field.args.map((a) => a.name));
        for (const arg of sel.args) {
          if (!known.has(arg.name)) {
            errors.push({
              message: `Field '${sel.name}' doesn't accept argument '${arg.name}'`,
              locations: [sel.loc],
              extensions: { code: 'argumentNotAccepted', name: sel.name, typeName, argumentName: arg.name },
            });
          }
        }
        const missing = field.args.filter((a) => a.type.k === 'NON_NULL' && !sel.args.some((x) => x.name === a.name)).map((a) => a.name);
        if (missing.length > 0) {
          errors.push({
            message: `Field '${sel.name}' is missing required arguments: ${missing.join(', ')}`,
            locations: [sel.loc],
            extensions: { code: 'missingRequiredArguments', className: 'Field', name: sel.name, arguments: missing.join(', ') },
          });
        }
        const inner = namedType(field.type);
        if (isLeaf(inner)) {
          if (sel.selectionSet !== null) {
            errors.push({
              message: `Field '${sel.name}' must not have a selection since type '${typeRefToString(field.type)}' has no subfields.`,
              locations: [sel.loc],
              extensions: { code: 'selectionMismatch', nodeName: sel.name, typeName: typeRefToString(field.type) },
            });
          }
        } else if (sel.selectionSet === null) {
          errors.push({
            message: `Field '${sel.name}' of type '${typeRefToString(field.type)}' must have a selection of subfields`,
            locations: [sel.loc],
            extensions: { code: 'selectionMismatch', nodeName: sel.name, typeName: typeRefToString(field.type) },
          });
        } else checkSelections(inner, sel.selectionSet);
      } else if (sel.kind === 'InlineFragment') {
        if (sel.typeCondition !== null && getType(sel.typeCondition) === undefined) {
          errors.push({ message: `No such type ${sel.typeCondition}, so it can't be a fragment condition`, locations: [sel.loc], extensions: { code: 'undefinedType', typeName: sel.typeCondition } });
          continue;
        }
        checkSelections(sel.typeCondition ?? typeName, sel.selectionSet);
      } else {
        const frag = doc.fragments.get(sel.name);
        if (frag === undefined) {
          errors.push({ message: `Fragment ${sel.name} was used, but not defined`, locations: [sel.loc], extensions: { code: 'undefinedFragment', fragmentName: sel.name } });
          continue;
        }
        if (stack.includes(sel.name)) {
          errors.push({ message: `Fragment ${sel.name} contains itself`, locations: [sel.loc], extensions: { code: 'fragmentCycle' } });
          continue;
        }
        if (validatedFragments.has(sel.name)) continue;
        validatedFragments.add(sel.name);
        if (getType(frag.typeCondition) === undefined) {
          errors.push({ message: `No such type ${frag.typeCondition}, so it can't be a fragment condition`, locations: [frag.loc], extensions: { code: 'undefinedType', typeName: frag.typeCondition } });
          continue;
        }
        stack.push(sel.name);
        checkSelections(frag.typeCondition, frag.selectionSet);
        stack.pop();
      }
    }
  };

  checkSelections(rootName, operation.selectionSet);
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

type Vars = Record<string, unknown>;

function valueOf(node: ValueNode, vars: Vars): unknown {
  switch (node.kind) {
    case 'Variable':
      return vars[node.name];
    case 'Int':
    case 'Float':
    case 'String':
    case 'Boolean':
    case 'Enum':
      return node.value;
    case 'Null':
      return null;
    case 'List':
      return node.values.map((v) => valueOf(v, vars));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) {
        const v = valueOf(f.value, vars);
        if (v !== undefined) out[f.name] = v;
      }
      return out;
    }
  }
}

function coerceArgs(field: FieldDef, nodes: ArgumentNode[], vars: Vars): Record<string, any> {
  const out: Record<string, any> = {};
  for (const def of field.args) {
    const node = nodes.find((n) => n.name === def.name);
    if (node === undefined) continue;
    const v = valueOf(node.value, vars);
    if (v !== undefined) out[def.name] = v;
  }
  for (const def of field.args) {
    if (def.type.k === 'NON_NULL' && (out[def.name] === undefined || out[def.name] === null)) {
      throw new GraphQLFieldError(`Argument '${def.name}' on Field '${field.name}' has an invalid value (null). Expected type '${typeRefToString(def.type)}'.`, 'argumentLiteralsIncompatible');
    }
  }
  return out;
}

function coerceVariables(operation: OperationNode, provided: Vars): { vars: Vars; errors: GraphQLErrorEntry[] } {
  const vars: Vars = {};
  const errors: GraphQLErrorEntry[] = [];
  for (const def of operation.variables) {
    const ref = typeNodeToRef(def.type);
    let value = provided[def.name];
    if (value === undefined && def.defaultValue !== null) value = valueOf(def.defaultValue, {});
    if (ref.k === 'NON_NULL' && (value === undefined || value === null)) {
      errors.push({
        message: value === undefined
          ? `Variable $${def.name} of type ${typeRefToString(ref)} was provided invalid value`
          : `Variable $${def.name} of type ${typeRefToString(ref)} was provided invalid value`,
        locations: [operation.loc],
        extensions: { value: value ?? null, problems: [{ path: [], explanation: 'Expected value to not be null' }] },
      });
      continue;
    }
    const base = namedType(ref);
    if (value !== undefined && value !== null) {
      const t = getType(base);
      if (t === undefined) {
        errors.push({ message: `${base} isn't a defined input type (on $${def.name})`, locations: [operation.loc], extensions: { code: 'variableRequiresValidType', typeName: base, variableName: def.name } });
        continue;
      }
      if (t.kind === 'ENUM' && typeof value === 'string' && !t.enumValues.includes(value)) {
        errors.push({
          message: `Variable $${def.name} of type ${typeRefToString(ref)} was provided invalid value`,
          locations: [operation.loc],
          extensions: { value, problems: [{ path: [], explanation: `Expected "${value}" to be one of: ${t.enumValues.join(', ')}` }] },
        });
        continue;
      }
    }
    if (value !== undefined) vars[def.name] = value;
  }
  return { vars, errors };
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

interface Run {
  doc: DocumentNode;
  vars: Vars;
  ctx: ExecContext;
  resolvers: ResolverMap;
  errors: GraphQLErrorEntry[];
}

function directivesAllow(directives: DirectiveNode[], vars: Vars): boolean {
  for (const d of directives) {
    if (d.name !== 'skip' && d.name !== 'include') continue;
    const arg = d.args.find((a) => a.name === 'if');
    const v = arg === undefined ? undefined : valueOf(arg.value, vars);
    if (d.name === 'skip' && v === true) return false;
    if (d.name === 'include' && v === false) return false;
  }
  return true;
}

function collectFields(run: Run, runtimeType: string, selections: SelectionNode[], out: Map<string, FieldNode[]>, seen: Set<string>): void {
  for (const sel of selections) {
    if (!directivesAllow(sel.directives, run.vars)) continue;
    if (sel.kind === 'Field') {
      const key = sel.alias ?? sel.name;
      const list = out.get(key);
      if (list === undefined) out.set(key, [sel]);
      else list.push(sel);
    } else if (sel.kind === 'InlineFragment') {
      if (sel.typeCondition === null || typeApplies(runtimeType, sel.typeCondition)) collectFields(run, runtimeType, sel.selectionSet, out, seen);
    } else {
      if (seen.has(sel.name)) continue;
      seen.add(sel.name);
      const frag: FragmentNode | undefined = run.doc.fragments.get(sel.name);
      if (frag !== undefined && typeApplies(runtimeType, frag.typeCondition)) collectFields(run, runtimeType, frag.selectionSet, out, seen);
    }
  }
}

function pushError(run: Run, message: string, node: FieldNode, path: (string | number)[], extra?: { type?: string; extensions?: Record<string, unknown> }): void {
  const entry: GraphQLErrorEntry = { message, path: [...path], locations: [node.loc] };
  if (extra?.type !== undefined) entry.type = extra.type;
  if (extra?.extensions !== undefined) entry.extensions = extra.extensions;
  run.errors.push(entry);
}

function executeObject(run: Run, typeName: string, source: unknown, selections: SelectionNode[], path: (string | number)[]): Record<string, unknown> {
  const def = getType(typeName) as TypeDef;
  const grouped = new Map<string, FieldNode[]>();
  collectFields(run, typeName, selections, grouped, new Set());
  const out: Record<string, unknown> = {};
  for (const [key, nodes] of grouped) {
    const node = nodes[0];
    if (node.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const field = def.fields.get(node.name);
    if (field === undefined) continue;
    const fieldPath = [...path, key];
    try {
      out[key] = executeField(run, def, field, source, nodes, fieldPath);
    } catch (e) {
      if (e instanceof NullBubble) {
        if (field.type.k === 'NON_NULL') throw e;
        out[key] = null;
      } else throw e;
    }
  }
  return out;
}

function executeField(run: Run, parent: TypeDef, field: FieldDef, source: unknown, nodes: FieldNode[], path: (string | number)[]): unknown {
  const node = nodes[0];
  let value: unknown;
  try {
    const args = coerceArgs(field, node.args, run.vars);
    const resolver = run.resolvers[parent.name]?.[field.name];
    value = resolver !== undefined ? resolver(source, args, run.ctx) : (source as Record<string, unknown> | null)?.[field.name];
  } catch (e) {
    if (e instanceof NullBubble) throw e;
    if (e instanceof GraphQLFieldError) pushError(run, e.message, node, path, { type: e.errorType, extensions: e.extensions });
    else if (e instanceof HttpError) pushError(run, e.message, node, path, { type: e.status === 404 ? 'NOT_FOUND' : e.status === 422 ? 'UNPROCESSABLE' : undefined });
    else pushError(run, e instanceof Error ? e.message : String(e), node, path);
    if (field.type.k === 'NON_NULL') throw new NullBubble();
    return null;
  }
  const selections: SelectionNode[] = [];
  for (const n of nodes) if (n.selectionSet !== null) selections.push(...n.selectionSet);
  return completeValue(run, field.type, value, selections, node, path, `${parent.name}.${field.name}`);
}

function completeValue(run: Run, ref: TypeRef, value: unknown, selections: SelectionNode[], node: FieldNode, path: (string | number)[], label: string): unknown {
  if (ref.k === 'NON_NULL') {
    const inner = completeValue(run, ref.of as TypeRef, value, selections, node, path, label);
    if (inner === null) {
      pushError(run, `Cannot return null for non-nullable field ${label}`, node, path);
      throw new NullBubble();
    }
    return inner;
  }
  if (value === null || value === undefined) return null;
  if (ref.k === 'LIST') {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item, i) => completeValue(run, ref.of as TypeRef, item, selections, node, [...path, i], label));
  }
  const name = ref.name as string;
  const def = getType(name) as TypeDef;
  if (def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
  let runtime = name;
  if (def.kind === 'INTERFACE' || def.kind === 'UNION') {
    const tn = (value as { __typename?: unknown }).__typename;
    if (typeof tn !== 'string') {
      pushError(run, `Could not resolve the concrete type of ${label}`, node, path);
      throw new NullBubble();
    }
    runtime = tn;
  }
  return executeObject(run, runtime, value, selections, path);
}

/** Run one operation of a parsed document. */
export function executeDocument(doc: DocumentNode, operationName: string | null, variables: unknown, ctx: ExecContext, resolvers: ResolverMap): ExecutionResult {
  let operation: OperationNode | undefined;
  if (operationName !== null && operationName !== undefined && operationName !== '') {
    operation = doc.operations.find((o) => o.name === operationName);
    if (operation === undefined) return { errors: [{ message: `No operation named '${operationName}'` }] };
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else if (doc.operations.length === 0) {
    return { errors: [{ message: 'No operation found in the document' }] };
  } else {
    return { errors: [{ message: 'An operation name is required when a document holds more than one operation' }] };
  }
  const provided = variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Vars) : {};
  const invalid = validateDocument(doc, operation);
  if (invalid.length > 0) return { errors: invalid };
  const coerced = coerceVariables(operation, provided);
  if (coerced.errors.length > 0) return { errors: coerced.errors };
  const run: Run = { doc, vars: coerced.vars, ctx, resolvers, errors: [] };
  const rootName = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  let data: Record<string, unknown> | null;
  try {
    data = executeObject(run, rootName, { __typename: rootName }, operation.selectionSet, []);
  } catch (e) {
    if (e instanceof NullBubble) data = null;
    else throw e;
  }
  const result: ExecutionResult = { data };
  if (run.errors.length > 0) result.errors = run.errors;
  return result;
}

export { implementors, parseTypeRef };
