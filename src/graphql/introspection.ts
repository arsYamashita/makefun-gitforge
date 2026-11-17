// Introspection: __schema and __type answer from the schema description in schema.ts.

import type { ResolverMap } from './execute.ts';
import { DIRECTIVES, TYPES, getType, implementors } from './schema.ts';
import type { ArgDef, TypeDef, TypeRef } from './schema.ts';

interface TypeSource {
  __typename: '__Type';
  ref: TypeRef;
}

function typeSource(ref: TypeRef): TypeSource {
  return { __typename: '__Type', ref };
}

function named(name: string): TypeSource {
  return typeSource({ k: 'NAMED', name });
}

function defOf(src: TypeSource): TypeDef | undefined {
  return src.ref.k === 'NAMED' ? getType(src.ref.name as string) : undefined;
}

function inputValue(arg: ArgDef): Record<string, unknown> {
  return {
    __typename: '__InputValue',
    name: arg.name,
    description: null,
    type: typeSource(arg.type),
    defaultValue: null,
    isDeprecated: false,
    deprecationReason: null,
  };
}

export const INTROSPECTION_RESOLVERS: ResolverMap = {
  Query: {
    __schema: () => ({
      __typename: '__Schema',
      description: null,
      types: [...TYPES.keys()].map(named),
      queryType: named('Query'),
      mutationType: named('Mutation'),
      subscriptionType: null,
      directives: DIRECTIVES.map((d) => ({
        __typename: '__Directive',
        name: d.name,
        description: d.description,
        locations: d.locations,
        args: d.args.map(inputValue),
        isRepeatable: false,
      })),
    }),
    __type: (_src, args) => (getType(String(args.name)) === undefined ? null : named(String(args.name))),
  },
  __Type: {
    kind: (src: TypeSource) => (src.ref.k === 'NAMED' ? (defOf(src) as TypeDef).kind : src.ref.k),
    name: (src: TypeSource) => (src.ref.k === 'NAMED' ? src.ref.name : null),
    description: () => null,
    specifiedByURL: () => null,
    ofType: (src: TypeSource) => (src.ref.k === 'NAMED' ? null : typeSource(src.ref.of as TypeRef)),
    fields: (src: TypeSource) => {
      const def = defOf(src);
      if (def === undefined || (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE')) return null;
      return [...def.fields.values()]
        .filter((f) => !f.name.startsWith('__'))
        .map((f) => ({
          __typename: '__Field',
          name: f.name,
          description: null,
          args: f.args.map(inputValue),
          type: typeSource(f.type),
          isDeprecated: false,
          deprecationReason: null,
        }));
    },
    interfaces: (src: TypeSource) => {
      const def = defOf(src);
      if (def === undefined || (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE')) return null;
      return def.interfaces.map(named);
    },
    possibleTypes: (src: TypeSource) => {
      const def = defOf(src);
      if (def === undefined) return null;
      if (def.kind === 'INTERFACE') return implementors(def.name).map(named);
      if (def.kind === 'UNION') return def.possible.map(named);
      return null;
    },
    enumValues: (src: TypeSource) => {
      const def = defOf(src);
      if (def === undefined || def.kind !== 'ENUM') return null;
      return def.enumValues.map((name) => ({ __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null }));
    },
    inputFields: (src: TypeSource) => {
      const def = defOf(src);
      if (def === undefined || def.kind !== 'INPUT_OBJECT') return null;
      return def.inputFields.map(inputValue);
    },
  },
};
