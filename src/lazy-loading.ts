import { isAnyType }       from '@itrocks/class-type'
import { KeyOf }           from '@itrocks/class-type'
import { Type }            from '@itrocks/class-type'
import { CollectionType }  from '@itrocks/property-type'
import { DeferredType }    from '@itrocks/property-type'
import { ReflectClass }    from '@itrocks/reflect'
import { ReflectProperty } from '@itrocks/reflect'
import { dataSource }      from '@itrocks/storage'
import { storeOf }         from '@itrocks/store'

export const PROTECT_GET = Symbol('protectGet')

type ModuleType = Record<string, any>

export type PropertyDescriptorWithProtectGet = PropertyDescriptor & ThisType<any> & { [PROTECT_GET]?: true }

const deferredActions = new Array<() => boolean>
const deferredModules = new Array<[any, any, string]>

function defineCollectionProperty<T extends object>(elementType: Type, property: KeyOf<T>, builtClass: Type<T>)
{
	const descriptor: PropertyDescriptorWithProtectGet = {
		configurable:  true,
		enumerable:    true,

		async get() {
			const ids = this[property + 'Ids']
			return this[property] = ids
				? await dataSource().readMultiple(elementType, ids)
				: await dataSource().readCollection(this, property, elementType)
		},

		set(value) {
			delete this[property + 'Ids']
			Object.defineProperty(this, property, { configurable: true, enumerable: true, value, writable: true })
			Reflect.defineMetadata(PROTECT_GET, false, this, property)
		}

	}
	Object.defineProperty(builtClass.prototype, property, descriptor)
	Reflect.defineMetadata(PROTECT_GET, true, builtClass.prototype, property)
	return property
}

function defineObjectProperty<T extends object>(type: Type, property: KeyOf<T>, builtClass: Type<T>)
{
	const descriptor: PropertyDescriptorWithProtectGet = {
		configurable: true,
		enumerable:   true,

		async get() {
			const id = this[property + 'Id']
			return this[property] = id ? await dataSource().read(type, id) : undefined
		},

		set(value) {
			delete this[property + 'Id']
			Object.defineProperty(this, property, { configurable: true, enumerable: true, value, writable: true })
			Reflect.defineMetadata(PROTECT_GET, false, this, property)
		}

	}
	Object.defineProperty(builtClass.prototype, property, descriptor)
	Reflect.defineMetadata(PROTECT_GET, true, builtClass.prototype, property)
	return property
}

function defineCollectionPropertyAction<T extends object>(
	BuiltClass: Type<T>, properties: KeyOf<T>[], property: ReflectProperty<T>
) {
	const type = property.collectionType.elementType.lead
	if (isAnyType(type)) {
		properties.push(defineCollectionProperty(type, property.name, BuiltClass))
		return true
	}
	return false
}

function defineObjectPropertyAction<T extends object>(
	BuiltClass: Type<T>, properties: KeyOf<T>[], property: ReflectProperty<T>
) {
	const type = property.type.lead
	if (isAnyType(type)) {
		properties.push(defineObjectProperty(type, property.name, BuiltClass))
		return true
	}
	return false
}

export function initClass<T extends object>(classType: Type<T>): Type<T> | undefined
{
	try { if (!storeOf(classType)) return }
	catch { return }

	const properties: KeyOf<T>[] = []

	// @ts-ignore TS2415 classType is always a heritable class, not a function.
	const BuiltClass: Type<T> = (() => class extends classType {
		[property: string]: any
		constructor(...args: any[]) {
			super(...args)
			for (const property of properties) {
				const value = Object.getOwnPropertyDescriptor(this, property)?.value
				if ((value === undefined) || (Array.isArray(value) && !value.length)) {
					delete this[property]
				}
				else {
					Reflect.defineMetadata(PROTECT_GET, false, this, property)
				}
			}
		}
	})()

	let resultingBuiltClass = undefined

	for (const property of new ReflectClass(classType).properties) {
		const propertyType = property.type
		if (!propertyType) continue
		if (propertyType instanceof CollectionType) {
			if (defineCollectionPropertyAction(BuiltClass, properties, property)) {
				resultingBuiltClass = BuiltClass
			}
			else if (propertyType.elementType.type instanceof DeferredType) {
				resultingBuiltClass = BuiltClass
				deferredActions.push(() => defineCollectionPropertyAction(BuiltClass, properties, property))
			}
		}
		else if (defineObjectPropertyAction(BuiltClass, properties, property)) {
			resultingBuiltClass = BuiltClass
		}
		else if (propertyType?.type instanceof DeferredType) {
			resultingBuiltClass = BuiltClass
			deferredActions.push(() => defineObjectPropertyAction(BuiltClass, properties, property))
		}
	}

	return resultingBuiltClass
}

export function initLazyLoading()
{
	const already = new Map<ModuleType, ModuleType | undefined>
	let   defer: boolean | undefined
	const Module  = require('module')
	const superRequire: (...args: any) => typeof Module = Module.prototype.require

	function initModule(module: ModuleType | undefined, original: ModuleType): ModuleType
	{
		defer = undefined
		let replacements = new Map<Type, Type>
		for (const [name, type] of Object.entries(original)) {
			defer = (defer === undefined)
				? (type === undefined)
				: (defer && (type === undefined))
			if (!isAnyType(type)) continue
			if (module && replacements) {
				const replacement = replacements.get(type)
				if (replacement) {
					module[name] = replacement
					continue
				}
			}
			const withORM = initClass(type)
			if (!withORM) continue
			replacements.set(type, withORM)
			if (!module) {
				module = { ...original }
				already.set(original, module)
			}
			module[name] = withORM
		}
		return (defer || replacements.size) ? (module ?? { ...original }) : original
	}

	function resolveDeferredActions()
	{
		while (deferredActions.length) {
			if (deferredActions[deferredActions.length - 1]()) deferredActions.pop()
			else break
		}
	}

	function resolveDeferredModules()
	{
		while (deferredModules.length) {
			const [original, module, file] = deferredModules[deferredModules.length - 1];
			if (initModule(module, original) === original) {
				Object.assign(module, original)
			}
			if (defer) break
			else {
				deferredModules.pop()
			}
		}
	}

	Module.prototype.require = function()
	{
		const original      = superRequire.call(this, ...arguments)
		const alreadyModule = already.get(original)
		if (alreadyModule) {
			return alreadyModule
		}
		already.set(original, original)

		const module = initModule(alreadyModule, original)
		if (defer) {
			// { ...original } into module may be enough. \/ this allows resolving during accessing value, if it is late.
			for (const [name, value] of Object.entries(original)) {
				Object.defineProperty(module, name, {
					configurable: true,
					enumerable:   true,
					get() {
						if (original[name] !== undefined) {
							resolveDeferredModules()
							resolveDeferredActions()
							return module[name]
						}
						return value
					},
					set(value) {
						let descriptor = Object.getOwnPropertyDescriptor(original, name)
							?? { configurable: true, enumerable: true }
						delete descriptor.get
						delete descriptor.set
						descriptor.value = value
						Object.defineProperty(module, name, descriptor)
					}
				})
			}
			already.set(original, module)
			deferredModules.push([original, module, arguments[0]])
		}

		resolveDeferredModules()
		resolveDeferredActions()

		return module ?? original
	}

}
