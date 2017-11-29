"use strict";

const fengari = require('fengari');
const lua     = fengari.lua;
const lauxlib = fengari.lauxlib;
const lualib  = fengari.lualib;

let custom_inspect_symbol;
if (!WEB) {
	try { /* for node.js */
		custom_inspect_symbol = require('util').inspect.custom;
	} catch (e) {}
}

const apply = Reflect.apply;
const construct = Reflect.construct;
const TypedArrayPrototype = Object.getPrototypeOf(new Int8Array());

const toString = function(o) {
	return ""+o;
};

const isobject = function(o) {
	return typeof o === "object" ? o !== null : typeof o === "function";
};

const js_tname = lua.to_luastring("js object");

const testjs = function(L, idx) {
	let u = lauxlib.luaL_testudata(L, idx, js_tname);
	if (u)
		return u.data;
	else
		return void 0;
};

const checkjs = function(L, idx) {
	return lauxlib.luaL_checkudata(L, idx, js_tname).data;
};

const pushjs = function(L, v) {
	let b = lua.lua_newuserdata(L);
	b.data = v;
	lauxlib.luaL_setmetatable(L, js_tname);
};

const getmainthread = function(L) {
	lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, lua.LUA_RIDX_MAINTHREAD);
	let mainL = lua.lua_tothread(L, -1);
	lua.lua_pop(L, 1);
	return mainL;
};

/* weak map from states to proxy objects (for each object) in that state */
const states = new WeakMap();

const atnativeerror = function(L) {
	let u = lua.lua_touserdata(L, 1);
	push(L, u);
	return 1;
};

const push = function(L, v) {
	switch (typeof v) {
	case "undefined":
		lua.lua_pushnil(L);
		break;
	case "number":
		lua.lua_pushnumber(L, v);
		break;
	case "string":
		lua.lua_pushstring(L, lua.to_luastring(v));
		break;
	case "boolean":
		lua.lua_pushboolean(L, v);
		break;
	case "symbol":
		lua.lua_pushlightuserdata(L, v);
		break;
	case "function":
		if (lua.lua_isproxy(v, L)) {
			v(L);
			break;
		}
		/* fall through */
	case "object":
		if (v === null) {
			/* can't use null in a WeakMap; grab from registry */
			lua.lua_rawgetp(L, lua.LUA_REGISTRYINDEX, null);
			break;
		}
		/* fall through */
	default:
		/* Try and push same object again */
		let objects_seen = states.get(getmainthread(L));
		let p = objects_seen.get(v);
		if (p) {
			p(L);
		} else {
			pushjs(L, v);
			p = lua.lua_toproxy(L, -1);
			objects_seen.set(v, p);
		}
	}
};

const tojs = function(L, idx) {
	switch(lua.lua_type(L, idx)) {
	case lua.LUA_TNONE:
	case lua.LUA_TNIL:
		return void 0;
	case lua.LUA_TBOOLEAN:
		return lua.lua_toboolean(L, idx);
	case lua.LUA_TLIGHTUSERDATA:
		return lua.lua_touserdata(L, idx);
	case lua.LUA_TNUMBER:
		return lua.lua_tonumber(L, idx);
	case lua.LUA_TSTRING:
		return lua.lua_tojsstring(L, idx);
	case lua.LUA_TUSERDATA:
		let u = testjs(L, idx);
		if (u !== void 0)
			return u;
		/* fall through */
	case lua.LUA_TTABLE:
	case lua.LUA_TFUNCTION:
	case lua.LUA_TTHREAD:
		/* fall through */
	default:
		return wrap(L, lua.lua_toproxy(L, idx));
	}
};

/* Calls function on the stack with `nargs` from the stack.
   On lua error, re-throws as javascript error
   On success, returns single return value */
const jscall = function(L, nargs) {
	let status = lua.lua_pcall(L, nargs, 1, 0);
	let r = tojs(L, -1);
	lua.lua_pop(L, 1);
	switch(status) {
	case lua.LUA_OK:
		return r;
	default:
		throw r;
	}
};

const invoke = function(L, p, thisarg, args, n_results) {
	lauxlib.luaL_checkstack(L, 2+args.length);
	if ((n_results === void 0) || (n_results === null)) {
		n_results = lua.LUA_MULTRET;
	}
	let base = lua.lua_gettop(L);
	p(L);
	push(L, thisarg);
	for (let i=0; i<args.length; i++) {
		push(L, args[i]);
	}
	switch(lua.lua_pcall(L, 1+args.length, n_results, 0)) {
	case lua.LUA_OK:
		let nres = lua.lua_gettop(L)-base;
		let res = new Array(nres);
		for (let i=0; i<nres; i++) {
			res[i] = tojs(L, base+i+1);
		}
		lua.lua_settop(L, base);
		return res;
	default:
		let r = tojs(L, -1);
		lua.lua_settop(L, base);
		throw r;
	}
};

const get = function(L, p, prop) {
	lauxlib.luaL_checkstack(L, 3);
	lua.lua_pushcfunction(L, function(L) {
		lua.lua_gettable(L, 1);
		return 1;
	});
	p(L);
	push(L, prop);
	return jscall(L, 2);
};

const has = function(L, p, prop) {
	lauxlib.luaL_checkstack(L, 3);
	lua.lua_pushcfunction(L, function(L) {
		lua.lua_gettable(L, 1);
		return 1;
	});
	p(L);
	push(L, prop);
	let status = lua.lua_pcall(L, 2, 1, 0);
	let r = lua.lua_isnil(L, -1);
	lua.lua_pop(L, 1);
	switch(status) {
	case lua.LUA_OK:
		return r;
	default:
		throw r;
	}
};

const set = function(L, p, prop, value) {
	lauxlib.luaL_checkstack(L, 4);
	lua.lua_pushcfunction(L, function(L) {
		lua.lua_settable(L, 1);
		return 0;
	});
	p(L);
	push(L, prop);
	push(L, value);
	switch(lua.lua_pcall(L, 3, 0, 0)) {
	case lua.LUA_OK:
		return;
	default:
		let r = tojs(L, -1);
		lua.lua_pop(L, 1);
		throw r;
	}
};

const deleteProperty = function(L, p, prop) {
	lauxlib.luaL_checkstack(L, 4);
	lua.lua_pushcfunction(L, function(L) {
		lua.lua_settable(L, 1);
		return 0;
	});
	p(L);
	push(L, prop);
	lua.lua_pushnil(L);
	switch(lua.lua_pcall(L, 3, 0, 0)) {
	case lua.LUA_OK:
		return;
	default:
		let r = tojs(L, -1);
		lua.lua_pop(L, 1);
		throw r;
	}
};

const tostring = function(L, p) {
	lauxlib.luaL_checkstack(L, 2);
	lua.lua_pushcfunction(L, function(L) {
		lauxlib.luaL_tolstring(L, 1);
		return 1;
	});
	p(L);
	return jscall(L, 1);
};

/* implements lua's "Generic For" protocol */
const iter_next = function() {
	let L = this.L;
	lauxlib.luaL_checkstack(L, 3);
	let top = lua.lua_gettop(L);
	this.iter(L);
	this.state(L);
	this.last(L);
	switch(lua.lua_pcall(L, 2, lua.LUA_MULTRET, 0)) {
	case lua.LUA_OK:
		this.last = lua.lua_toproxy(L, top+1);
		let r;
		if (lua.lua_isnil(L, -1)) {
			r = {
				done: true,
				value: void 0
			};
		} else {
			let n_results = lua.lua_gettop(L) - top;
			let result = new Array(n_results);
			for (let i=0; i<n_results; i++) {
				result[i] = tojs(L, top+i+1);
			}
			r = {
				done: false,
				value: result
			};
		}
		lua.lua_settop(L, top);
		return r;
	default:
		let e = tojs(L, -1);
		lua.lua_pop(L, 1);
		throw e;
	}
};

/* make iteration use pairs() */
const jsiterator = function(L, p) {
	lauxlib.luaL_checkstack(this.L, 2);
	lauxlib.luaL_requiref(L, lua.to_luastring("_G"), lualib.luaopen_base, 0);
	lua.lua_getfield(L, -1, lua.to_luastring("pairs"));
	lua.lua_remove(L, -2);
	p(L);
	switch(lua.lua_pcall(L, 1, 3, 0)) {
	case lua.LUA_OK:
		let iter = lua.lua_toproxy(L, -3);
		let state = lua.lua_toproxy(L, -2);
		let last = lua.lua_toproxy(L, -1);
		lua.lua_pop(L, 3);
		return {
			L: L,
			iter: iter,
			state: state,
			last: last,
			next: iter_next
		};
	default:
		let r = tojs(L, -1);
		lua.lua_pop(L, 1);
		throw r;
	}
};

const wrap = function(L1, p) {
	const L = getmainthread(L1);
	/* we need `typeof js_proxy` to be "function" so that it's acceptable to native apis */
	let js_proxy = function() {
		/* only get one result */
		return invoke(L, p, this, arguments, 1)[0];
	};
	js_proxy.apply = function(thisarg, args) {
		/* only get one result */
		return invoke(L, p, thisarg, args, 1)[0];
	};
	js_proxy.invoke = function(thisarg, args) {
		return invoke(L, p, thisarg, args, lua.LUA_MULTRET);
	};
	js_proxy.get = function(k) {
		return get(L, p, k);
	};
	js_proxy.has = function(k) {
		return has(L, p, k);
	};
	js_proxy.set = function(k, v) {
		return set(L, p, k, v);
	};
	js_proxy.delete = function(k) {
		return deleteProperty(L, p, k);
	};
	js_proxy.toString = function() {
		return tostring(L, p);
	};
	js_proxy[Symbol.toStringTag] = "Fengari object";
	js_proxy[Symbol.iterator] = function() {
		return jsiterator(L, p);
	};
	if (Symbol.toPrimitive) {
		js_proxy[Symbol.toPrimitive] = function(hint) {
			if (hint === "string") {
				return tostring(L, p);
			}
		};
	}
	if (custom_inspect_symbol) {
		js_proxy[custom_inspect_symbol] = js_proxy.toString;
	}
	states.get(L).set(js_proxy, p);
	return js_proxy;
};

const L_symbol = Symbol("lua_State");
const p_symbol = Symbol("fengari-proxy");

const proxy_handlers = {
	"apply": function(target, thisarg, args) {
		return invoke(target[L_symbol], target[p_symbol], thisarg, args, 1)[0];
	},
	"construct": function(target, argumentsList) {
		let L = target[L_symbol];
		let p = target[p_symbol];
		let arg_length = argumentsList.length;
		lauxlib.luaL_checkstack(L, 2+arg_length);
		p(L);
		let idx = lua.lua_gettop(L);
		if (lauxlib.luaL_getmetafield(L, idx, lua.to_luastring("construct")) === lua.LUA_TNIL) {
			lua.lua_pop(L, 1);
			throw new TypeError("not a constructor");
		}
		lua.lua_rotate(L, idx, 1);
		for (let i=0; i<arg_length; i++) {
			push(L, argumentsList[i]);
		}
		return jscall(L, 1+arg_length);
	},
	"defineProperty": function(target, prop, desc) {
		let L = target[L_symbol];
		let p = target[p_symbol];
		lauxlib.luaL_checkstack(L, 4);
		p(L);
		if (lauxlib.luaL_getmetafield(L, -1, lua.to_luastring("defineProperty")) === lua.LUA_TNIL) {
			lua.lua_pop(L, 1);
			return false;
		}
		lua.lua_rotate(L, -2, 1);
		push(L, prop);
		push(L, desc);
		return jscall(L, 3);
	},
	"deleteProperty": function(target, k) {
		return deleteProperty(target[L_symbol], target[p_symbol], k);
	},
	"get": function(target, k) {
		return get(target[L_symbol], target[p_symbol], k);
	},
	"getOwnPropertyDescriptor": function(target, prop) {
		let L = target[L_symbol];
		let p = target[p_symbol];
		lauxlib.luaL_checkstack(L, 3);
		p(L);
		if (lauxlib.luaL_getmetafield(L, -1, lua.to_luastring("getOwnPropertyDescriptor")) === lua.LUA_TNIL) {
			lua.lua_pop(L, 1);
			return;
		}
		lua.lua_rotate(L, -2, 1);
		push(L, prop);
		return jscall(L, 2);
	},
	"getPrototypeOf": function(target) {
		let L = target[L_symbol];
		let p = target[p_symbol];
		lauxlib.luaL_checkstack(L, 2);
		p(L);
		if (lauxlib.luaL_getmetafield(L, -1, lua.to_luastring("getPrototypeOf")) === lua.LUA_TNIL) {
			lua.lua_pop(L, 1);
			return null;
		}
		lua.lua_rotate(L, -2, 1);
		return jscall(L, 1);
	},
	"has": function(target, k) {
		return has(target[L_symbol], target[p_symbol], k);
	},
	"ownKeys": function(target) {
		let L = target[L_symbol];
		let p = target[p_symbol];
		lauxlib.luaL_checkstack(L, 2);
		p(L);
		if (lauxlib.luaL_getmetafield(L, -1, lua.to_luastring("ownKeys")) === lua.LUA_TNIL) {
			lua.lua_pop(L, 1);
			return;
		}
		lua.lua_rotate(L, -2, 1);
		return jscall(L, 1);
	},
	"set": function(target, k, v) {
		return set(target[L_symbol], target[p_symbol], k, v);
	},
	"setPrototypeOf": function(target, prototype) {
		let L = target[L_symbol];
		let p = target[p_symbol];
		lauxlib.luaL_checkstack(L, 3);
		p(L);
		if (lauxlib.luaL_getmetafield(L, -1, lua.to_luastring("setPrototypeOf")) === lua.LUA_TNIL) {
			lua.lua_pop(L, 1);
			return false;
		}
		lua.lua_rotate(L, -2, 1);
		push(L, prototype);
		return jscall(L, 2);
	}
};

const valid_types = ["function", "object"];
const valid_types_as_luastring = valid_types.map((v) => lua.to_luastring(v));

const createproxy = function(L1, p, type) {
	const L = getmainthread(L1);
	let target;
	switch (type) {
	case "function":
		target = function(){};
		break;
	case "object":
		target = {};
		break;
	default:
		throw TypeError("invalid type to createproxy");
	}
	target[p_symbol] = p;
	target[L_symbol] = L;
	return new Proxy(target, proxy_handlers);
};

const get_iterator = function(L, idx) {
	let u = checkjs(L, idx);
	let getiter = u[Symbol.iterator];
	if (!getiter)
		lauxlib.luaL_argerror(L, idx, lua.to_luastring("object not iterable"));
	let iter = apply(getiter, u, []);
	if (!isobject(iter))
		lauxlib.luaL_argerror(L, idx, lua.to_luastring("Result of the Symbol.iterator method is not an object"));
	return iter;
};

const next = function(L) {
	let iter = tojs(L, 1);
	let r = iter.next();
	if (r.done) {
		return 0;
	} else {
		push(L, r.value);
		return 1;
	}
};

let jslib = {
	"new": function(L) {
		let u = tojs(L, 1);
		let nargs = lua.lua_gettop(L)-1;
		let args = new Array(nargs);
		for (let i = 0; i < nargs; i++) {
			args[i] = tojs(L, i+2);
		}
		push(L, construct(u, args));
		return 1;
	},
	"of": function(L) {
		let iter = get_iterator(L, 1);
		lua.lua_pushcfunction(L, next);
		push(L, iter);
		return 2;
	},
	"createproxy": function(L) {
		lauxlib.luaL_checkany(L, 1);
		let type = valid_types[lauxlib.luaL_checkoption(L, 2, valid_types_as_luastring[0], valid_types_as_luastring)];
		let fengariProxy = createproxy(L, lua.lua_toproxy(L, 1), type);
		push(L, fengariProxy);
		return 1;
	},
	"tonumber": function(L) {
		let u = tojs(L, 1);
		lua.lua_pushnumber(L, +u);
		return 1;
	},
	"instanceof": function(L) {
		let u1 = tojs(L, 1);
		let u2 = tojs(L, 2);
		lua.lua_pushboolean(L, u1 instanceof u2);
		return 1;
	}
};

let jsmt = {
	"__index": function(L) {
		let u = checkjs(L, 1);
		let k = tojs(L, 2);
		push(L, u[k]);
		return 1;
	},
	"__newindex": function(L) {
		let u = checkjs(L, 1);
		let k = tojs(L, 2);
		let v = tojs(L, 3);
		if (v === void 0)
			delete u[k];
		else
			u[k] = v;
		return 0;
	},
	"__tostring": function(L) {
		let u = checkjs(L, 1);
		let s = toString(u);
		lua.lua_pushstring(L, lua.to_luastring(s));
		return 1;
	},
	"__call": function(L) {
		let u = checkjs(L, 1);
		let nargs = lua.lua_gettop(L)-1;
		let thisarg;
		let args = new Array(nargs-1);
		if (nargs > 0) {
			thisarg = tojs(L, 2);
			if (nargs-- > 0) {
				for (let i = 0; i < nargs; i++) {
					args[i] = tojs(L, i+3);
				}
			}
		}
		push(L, apply(u, thisarg, args));
		return 1;
	},
	"__pairs": function(L) {
		let u = checkjs(L, 1);
		let f = u[Symbol.for("__pairs")];
		if (f === void 0)
			lauxlib.luaL_argerror(L, 1, lua.to_luastring("js object has no __pairs Symbol"));
		let r = apply(f, u, []);
		if (r === void 0)
			lauxlib.luaL_error(L, lua.to_luastring("bad '__pairs' result (object with keys 'iter', 'state', 'first' expected)"));
		let iter = r.iter;
		if (iter === void 0)
			lauxlib.luaL_error(L, lua.to_luastring("bad '__pairs' result (object.iter is missing)"));
		lua.lua_pushcfunction(L, function() {
			let state = tojs(L, 1);
			let last = tojs(L, 2);
			let r = iter.call(state, last);
			/* returning undefined indicates end of iteration */
			if (r === void 0)
				return 0;
			/* otherwise it should return an array of results */
			if (!Array.isArray(r))
				lauxlib.luaL_error(L, lua.to_luastring("bad iterator result (Array or undefined expected)"));
			lauxlib.luaL_checkstack(L, r.length);
			for (let i=0; i<r.length; i++) {
				push(L, r[i]);
			}
			return r.length;
		});
		push(L, r.state);
		push(L, r.first);
		return 3;
	},
	"__len": function(L) {
		let u = checkjs(L, 1);
		let f = u[Symbol.for("__len")];
		if (f === void 0)
			lauxlib.luaL_argerror(L, 1, lua.to_luastring("js object has no __len Symbol"));
		let r = apply(f, u, []);
		push(L, r);
		return 1;
	}
};

/* Create __pairs for all objects that inherit from Object */
Object.prototype[Symbol.for("__pairs")] = function() {
	return {
		"iter": function(last) {
			if (this.index >= this.keys.length)
				return;
			let key = this.keys[this.index++];
			return [key, this.object[key]];
		},
		"state": {
			object: this,
			keys: Object.keys(this),
			index: 0,
		}
	};
};

/* Create __len for all objects that inherit from Array */
const __len = function() {
	return this.length;
};
Array.prototype[Symbol.for("__len")] = __len;
TypedArrayPrototype[Symbol.for("__len")] = __len;

const luaopen_js = function(L) {
	/* Add weak map to track objects seen */
	states.set(getmainthread(L), new WeakMap());

	lua.lua_atnativeerror(L, atnativeerror);

	lauxlib.luaL_newlib(L, jslib);

	lauxlib.luaL_newmetatable(L, js_tname);
	lauxlib.luaL_setfuncs(L, jsmt, 0);
	lua.lua_pop(L, 1);

	pushjs(L, null);
	/* Store null object in registry under lightuserdata null */
	lua.lua_pushvalue(L, -1);
	lua.lua_rawsetp(L, lua.LUA_REGISTRYINDEX, null);
	lua.lua_setfield(L, -2, lua.to_luastring("null"));

	if (WEB) {
		push(L, window);
	} else {
		push(L, global);
	}
	lua.lua_setfield(L, -2, lua.to_luastring("global"));

	return 1;
};

module.exports.checkjs = checkjs;
module.exports.testjs = testjs;
module.exports.pushjs = pushjs;
module.exports.push = push;
module.exports.tojs = tojs;
module.exports.luaopen_js = luaopen_js;
