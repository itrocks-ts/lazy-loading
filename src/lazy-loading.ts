import { isAnyType }       from '@itrocks/class-type'
import { KeyOf, Type }     from '@itrocks/class-type'
import { CollectionType }  from '@itrocks/property-type'
import { ReflectClass }    from '@itrocks/reflect'
import { dataSource }      from '@itrocks/storage'
import { storeOf }         from '@itrocks/store'

export const PROTECT_GET = Symbol('protectGet')

export type PropertyDescriptorWithProtectGet = PropertyDescriptor & ThisType<any> & { [PROTECT_GET]?: true }

function defineCollectionProperty<T extends object>(type: CollectionType, property: KeyOf<T>, builtClass: Type<T>)
{
	const descriptor: PropertyDescriptorWithProtectGet = {
		configurable:  true,
		enumerable:    true,

		async get() {
			const elementType = type.elementType.type as Type
			const ids         = this[property + 'Ids']
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

	for (const property of new ReflectClass(classType).properties) {
		const propertyType = property.type
		if (!propertyType) continue
		if ((propertyType instanceof CollectionType) && isAnyType(propertyType.elementType.type)) {
			properties.push(defineCollectionProperty(propertyType, property.name, BuiltClass))
		}
		else if (isAnyType(propertyType?.type)) {
			properties.push(defineObjectProperty(propertyType.type, property.name, BuiltClass))
		}
	}

	return properties.length ? BuiltClass : undefined
}

export function initLazyLoading()
{
	const Module = require('module')
	const superRequire: (...args: any) => typeof Module = Module.prototype.require

	Module.prototype.require = function()
	{
		const original = superRequire.call(this, ...arguments)
		let module:       Record<string, any> | undefined
		let replacements: Map<Type, Type> | undefined
		for (const [name, type] of Object.entries(original)) {
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
			if (!replacements) {
				module       = { ...original }
				replacements = new Map()
			}
			replacements.set(type, withORM)
			// @ts-ignore TS18048 but module is always initialized
			module[name] = withORM
		}
		return module ?? original
	}
}
