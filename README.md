[![npm version](https://img.shields.io/npm/v/@itrocks/lazy-loading?logo=npm)](https://www.npmjs.org/package/@itrocks/lazy-loading)
[![npm downloads](https://img.shields.io/npm/dm/@itrocks/lazy-loading)](https://www.npmjs.org/package/@itrocks/lazy-loading)
[![GitHub](https://img.shields.io/github/last-commit/itrocks-ts/lazy-loading?color=2dba4e&label=commit&logo=github)](https://github.com/itrocks-ts/lazy-loading)
[![issues](https://img.shields.io/github/issues/itrocks-ts/lazy-loading)](https://github.com/itrocks-ts/lazy-loading/issues)
[![discord](https://img.shields.io/discord/1314141024020467782?color=7289da&label=discord&logo=discord&logoColor=white)](https://25.re/ditr)

# lazy-loading

Integrates lazy loading for objects and collections in TypeScript classes.

*This documentation was written by an artificial intelligence and may contain errors or approximations.
It has not yet been fully reviewed by a human. If anything seems unclear or incomplete,
please feel free to contact the author of this package.*

## Installation

```bash
npm i @itrocks/lazy-loading
```

You will typically use this package together with `@itrocks/store` and
`@itrocks/storage`, which provide the actual persistence layer.

## Usage

`@itrocks/lazy-loading` hooks into Node's module loader to automatically
wrap your entity classes and add lazy properties to them.

At application startup, call `initLazyLoading()` **before importing the
modules that declare your entity classes**. Any exported entity class with
`@itrocks/store` metadata will then be replaced by a lazily-loading
variant.

### Minimal example

```ts
// main.ts (entrypoint)
import { initLazyLoading } from '@itrocks/lazy-loading'

// Enable lazy loading for subsequently required modules
initLazyLoading()

// After this point, imports may be wrapped with lazy-loading behaviour
import { User } from './user.js'

async function run() {
  // Assuming the store and data source are configured elsewhere
  const user = new User()

  // When first accessed, `user.profile` will be loaded from the data source
  const profile = await user.profile
}

run().catch(console.error)
```

```ts
// user.ts
import { AnyType, Type } from '@itrocks/class-type'
import { store }         from '@itrocks/store'

@store({ /* store options */ })
export class User {
  id = 0

  // A lazily-loaded single object
  profile?: Profile
  profileId?: number

  // A lazily-loaded collection
  roles: Role[] = []
  roleIds?: number[]
}

export class Profile {
  id   = 0
  name = ''
}

export class Role {
  id   = 0
  name = ''
}
```

In this example, the `User` class is annotated with a store decorator
from `@itrocks/store`. Once `initLazyLoading()` has been called, the
exported `User` class is replaced with a subclass whose `profile` and
`roles` properties are:

- defined as asynchronous getters that
  - read `profileId` / `roleIds` when present and load the referenced
    objects from the configured data source, or
  - fall back to reading the related objects/collections directly from
    the store;
- writable: once you explicitly assign `user.profile` or `user.roles`,
  the value is stored on the instance and will no longer trigger a
  reload on access.

The convention is that each lazily-loaded property may have a matching
identifier field:

- `property` ↔ `propertyId`
- `property` (collection) ↔ `propertyIds`

### Example with manual class initialization

If you do not want to use the global module loader hook, you can call
`initClass()` manually on your entity classes.

```ts
import { initClass } from '@itrocks/lazy-loading'

class Order {
  id = 0

  customer?: Customer
  customerId?: number
}

class Customer {
  id   = 0
  name = ''
}

// Create a lazily-loading variant of Order, if applicable
const LazyOrder = initClass(Order) ?? Order

async function process(orderId: number) {
  const order = new LazyOrder()
  order.id = orderId

  // First access will load `customer` based on `customerId`
  const customer = await order.customer
}
```

Here, `initClass(Order)` inspects the `Order` metadata and, when it
finds lazily-loadable properties, returns a subclass that contains the
lazy getters. If the class cannot be configured for lazy loading (for
instance, because it is not associated with a store), `initClass()`
returns `undefined` and you can fall back to using the original class.

## API

### `const PROTECT_GET: unique symbol`

Symbol used as a metadata key on lazily-loaded properties.

This symbol is exposed for advanced integrations with custom
persistence/ORM layers. Typical usages include:

- detecting whether a property is currently under lazy-loading
  protection (its value is managed by the lazy getter), and
- deciding whether a persistence layer should re-fetch or reuse the
  in-memory value when saving.

Most applications do not need to access `PROTECT_GET` directly. The
`@itrocks/framework` integration uses it behind the scenes when
implementing database transformers.

---

### `type PropertyDescriptorWithProtectGet`

```ts
type PropertyDescriptorWithProtectGet = PropertyDescriptor & ThisType<any> & {
  [PROTECT_GET]?: true
}
```

Helper type describing property descriptors that may carry the
`PROTECT_GET` marker. This is primarily useful when extending or
customizing the lazy-loading behaviour at a low level, for example when
defining additional decorators or property interceptors.

---

### `function initClass<T extends object>(classType: Type<T>): Type<T> | undefined`

Analyses the given class and returns a lazily-loading subclass when at
least one property can be configured for lazy loading.

The returned subclass extends `classType` and overrides qualifying
properties with asynchronous getters/setters that:

- lazily load a single related object based on `propertyId`,
- lazily load a collection based on `propertyIds`, or
- lazily fetch related data from the configured store when no id field
  exists.

#### Parameters

- `classType` – the entity class to inspect and wrap with lazy-loading
  behaviour.

#### Return value

- `Type<T> | undefined` – a subclass of `classType` that implements
  lazy loading, or `undefined` if the class cannot be configured (for
  example, because no store is registered for it).

#### Example

```ts
import type { Type } from '@itrocks/class-type'
import { initClass } from '@itrocks/lazy-loading'

function withLazyLoading<T extends object>(classType: Type<T>): Type<T> {
  return initClass(classType) ?? classType
}

// Later, when registering entities
const LazyUser = withLazyLoading(User)
```

---

### `function initLazyLoading(): void`

Installs a global hook on Node's module loader so that exported entity
classes are transparently replaced by lazily-loading subclasses.

Once `initLazyLoading()` has been called, every subsequent `require()`
or `import` is inspected. For each exported value that looks like an
entity class (based on `@itrocks/store` metadata):

- its properties are analysed via reflection,
- eligible properties are replaced with lazy getters/setters, and
- the module export is updated to reference the new subclass.

The hook also handles *deferred types*, so that circular or late-bound
dependencies between entities can still benefit from lazy loading.

Call this function only once, early in your application's startup
sequence, before loading the bulk of your entity modules.

## Typical use cases

- Add transparent lazy loading to entity relationships (one-to-one or
  one-to-many) without changing your domain model code.
- Defer loading of large collections until they are actually accessed,
  reducing memory usage and database round-trips.
- Work with simple `Id`/`Ids` fields while exposing rich object graphs
  to the rest of the application.
- Integrate with `@itrocks/framework`, which automatically enables lazy
  loading and uses `PROTECT_GET` when reading from and writing to the
  database.
- Implement advanced persistence strategies by inspecting
  `PROTECT_GET` metadata when deciding how and when to persist entity
  properties.
