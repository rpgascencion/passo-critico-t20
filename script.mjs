/**
 * Passo no Crítico (T20)
 *
 * Para armas configuradas (ex: Espada de Obsidiana), aumenta o dado de
 * dano em N passos ANTES da multiplicação de crítico nativa do sistema
 * Tormenta20 (que multiplica o número de dados, ex: 1d8 crítico x2 -> 2d8).
 *
 * Baseado na leitura do código-fonte real do sistema (module/documents/item.mjs
 * e module/dataModel/item/physical/weapon.mjs):
 *  - item.system.criticoM  = margem de ameaça (padrão 20)
 *  - item.system.criticoX  = multiplicador de crítico (padrão 2)
 *  - item.system.rolled.Ataque._critical = true/false, setado por rollAttack()
 *    ANTES de rollDamage() ser chamado (na mesma sequência de item.roll()).
 *  - item.system.rolls.find(r => r.type === "dano").parts[0][0] = fórmula
 *    base do dado de dano (ex: "1d8"), que o próprio sistema já muta
 *    diretamente em outros pontos do código (ex: propriedade "adaptável"),
 *    então mutar esse campo antes de rollDamage() é seguro.
 *
 * Este módulo intercepta ItemT20.prototype.rollDamage via libWrapper,
 * ANTES de chamar a implementação original: se a arma está configurada e o
 * ataque foi crítico, aumenta o dado de passo (usando a tabela oficial
 * CONFIG.T20.passosDano, a mesma que o sistema usa para outros poderes),
 * deixa o sistema rolar normalmente (ele já multiplica o dado nativamente)
 * e depois restaura a fórmula original no objeto (que normalmente é um
 * clone descartável criado por item.roll(), mas restauramos por segurança
 * de qualquer forma).
 */

const MOD_ID = "passo-critico-t20";

function aumentarPasso(dado, passos = 1) {
	// Usa a tabela OFICIAL do próprio sistema (module/config/T20.js),
	// a mesma que o T20 usa internamente para aplicar "passos" de outros
	// poderes/efeitos (ex: Mão Lesta). Antes usávamos uma tabela própria,
	// que não continha todos os valores possíveis (ex: "3d6"), causando
	// falha quando outro poder já tinha empurrado o dado além de 1d12.
	const tabela = CONFIG.T20?.passosDano;
	if (!tabela) {
		console.warn(`${MOD_ID} | CONFIG.T20.passosDano não encontrado — verifique a versão do sistema.`);
		return dado;
	}
	const dadoLimpo = dado.replace(/\s/g, "");
	const linha = tabela.find((l) => l.includes(dadoLimpo));
	if (!linha) return dado; // valor fora de qualquer linha da tabela -> não mexe
	const idx = linha.indexOf(dadoLimpo);
	const novoIdx = Math.max(0, Math.min(idx + passos, linha.length - 1));
	return linha[novoIdx];
}

function stepFormula(formula, passos = 1) {
	const match = String(formula).match(/(\d+)\s*d\s*(\d+)/i);
	if (!match) return formula;
	const dadoOriginal = `${match[1]}d${match[2]}`;
	const dadoNovo = aumentarPasso(dadoOriginal, passos);
	return formula.replace(match[0], dadoNovo);
}

function getConfig() {
	try {
		const raw = game.settings.get(MOD_ID, "armas");
		const obj = JSON.parse(raw || "{}");
		// normaliza chaves para comparação (trim + minúsculas)
		const norm = {};
		for (const [nome, passos] of Object.entries(obj)) {
			norm[nome.trim().toLowerCase()] = Number(passos) || 0;
		}
		return norm;
	} catch (err) {
		console.error(`${MOD_ID} | JSON inválido na configuração:`, err);
		return {};
	}
}

Hooks.once("init", () => {
	game.settings.register(MOD_ID, "armas", {
		name: "Armas com aumento de passo no crítico",
		hint: 'Formato JSON: {"Nome exato da arma": passos}. Ex: {"Espada de Obsidiana": 1, "Machado Brutal": 2}. O nome precisa bater (sem diferenciar maiúsculas/minúsculas) com o nome do item no Foundry.',
		scope: "world",
		config: true,
		type: String,
		default: '{"Espada de Obsidiana": 1}'
	});
});

Hooks.once("ready", () => {
	if (game.system.id !== "tormenta20") return;

	if (!game.modules.get("lib-wrapper")?.active) {
		ui.notifications.error(
			"Passo no Crítico (T20): o módulo 'libWrapper' precisa estar instalado e ativo."
		);
		return;
	}

	const ItemT20 = CONFIG.Item.documentClass;
	if (!ItemT20?.prototype?.rollDamage) {
		console.error(`${MOD_ID} | Não encontrei ItemT20.prototype.rollDamage — verifique a versão do sistema.`);
		return;
	}

	libWrapper.register(
		MOD_ID,
		"CONFIG.Item.documentClass.prototype.rollDamage",
		async function (wrapped, ...args) {
			// Só nos importa armas
			if (this.type !== "arma") return wrapped(...args);

			const config = getConfig();
			const chaveArma = this.name?.trim().toLowerCase();
			const passos = config[chaveArma] ?? 0;
			const critico = this.system.rolled?.Ataque?._critical || false;

			console.log(
				`${MOD_ID} | [debug] arma="${this.name}" passosConfigurados=${passos} critico=${critico}`,
				{ rolled: foundry.utils.deepClone(this.system.rolled ?? {}), rollsAtual: foundry.utils.deepClone(this.system.rolls) }
			);

			if (!(passos > 0 && critico)) {
				console.log(`${MOD_ID} | [debug] não aplicado (passos>0 && critico) = false`);
				return wrapped(...args);
			}

			const danoRoll = this.system.rolls.find((r) => r.type === "dano");
			if (!danoRoll?.parts?.[0]?.[0]) {
				console.log(`${MOD_ID} | [debug] não encontrei danoRoll.parts[0][0] válido`, danoRoll);
				return wrapped(...args);
			}

			const original = danoRoll.parts[0][0];
			const novo = stepFormula(original, passos);

			console.log(`${MOD_ID} | [debug] original="${original}" novo="${novo}"`);

			if (novo === original) {
				console.log(`${MOD_ID} | [debug] stepFormula não alterou nada (fórmula fora da tabela ou regex não bateu)`);
				return wrapped(...args);
			}

			danoRoll.parts[0][0] = novo;
			console.log(
				`${MOD_ID} | Crítico com "${this.name}": dado de dano ${original} -> ${novo} (${passos} passo(s)), antes da multiplicação nativa (x${this.system.criticoX}).`
			);

			try {
				return await wrapped(...args);
			} finally {
				// Restaura a fórmula original (this normalmente é um clone
				// descartável criado por item.roll(), mas restauramos por
				// segurança caso rollDamage seja chamado diretamente).
				danoRoll.parts[0][0] = original;
			}
		},
		"WRAPPER"
	);

	console.log(`${MOD_ID} | Registrado com sucesso.`);
});

// Ajuda opcional via console: game.passoCriticoT20.configurar("Nome da Arma", 1)
Hooks.once("ready", () => {
	game.passoCriticoT20 = {
		configurar: async (nomeArma, passos) => {
			const atual = getConfig();
			atual[nomeArma.trim().toLowerCase()] = passos;
			// converte de volta pra JSON "bonito" preservando os nomes originais
			// (aqui simplificado: grava com o nome já normalizado)
			const novoObj = {};
			for (const [k, v] of Object.entries(atual)) novoObj[k] = v;
			await game.settings.set(MOD_ID, "armas", JSON.stringify(novoObj, null, 2));
			ui.notifications.info(`Passo no Crítico (T20): "${nomeArma}" configurada com ${passos} passo(s).`);
		}
	};
});
