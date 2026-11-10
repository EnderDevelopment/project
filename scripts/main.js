import { world, system, ItemStack } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";

const KEY = "global_market_state";
const BOOK = "minecraft:book";
const STARTING_BALANCE = 500;
const GOODS = [
  { id: "minecraft:iron_ingot", name: "Железный слиток", base: 8, buy: 5 },
  { id: "minecraft:gold_ingot", name: "Золотой слиток", base: 14, buy: 9 },
  { id: "minecraft:diamond", name: "Алмаз", base: 80, buy: 55 },
  { id: "minecraft:emerald", name: "Изумруд", base: 30, buy: 20 },
  { id: "minecraft:coal", name: "Уголь", base: 3, buy: 2 },
  { id: "minecraft:wheat", name: "Пшеница", base: 2, buy: 1 }
];
let state = { players: {}, listings: [], portals: [], stalls: [], history: {} };

function load() {
  try { const raw = world.getDynamicProperty(KEY); if (typeof raw === "string") state = { ...state, ...JSON.parse(raw) }; } catch {}
}
function save() { world.setDynamicProperty(KEY, JSON.stringify(state)); }
function playerData(player) {
  const id = player.id;
  if (!state.players[id]) state.players[id] = { name: player.name, balance: STARTING_BALANCE, joined: true };
  state.players[id].name = player.name;
  save();
  return state.players[id];
}
function money(player) { return playerData(player).balance; }
function marketPrice(id) {
  const good = GOODS.find(x => x.id === id);
  const supply = state.listings.filter(x => x.item === id).length;
  const price = good.base * (1 + Math.max(-0.3, Math.min(0.8, (2 - supply) * 0.08)));
  return Math.max(1, Math.round(price));
}
function trend(id) {
  const now = marketPrice(id), before = state.history[id];
  return before == null || now === before ? "⊖" : now > before ? "↑" : "↓";
}
function inventory(player) { return player.getComponent("minecraft:inventory").container; }
function countItem(player, typeId) {
  let total = 0; const inv = inventory(player);
  for (let i = 0; i < inv.size; i++) { const item = inv.getItem(i); if (item?.typeId === typeId) total += item.amount; }
  return total;
}
function removeItem(player, typeId, amount) {
  const inv = inventory(player); let left = amount;
  for (let i = 0; i < inv.size && left > 0; i++) {
    const item = inv.getItem(i); if (item?.typeId !== typeId) continue;
    const take = Math.min(left, item.amount); left -= take;
    if (take === item.amount) inv.setItem(i, undefined); else { item.amount -= take; inv.setItem(i, item); }
  }
  return left === 0;
}
function give(player, typeId, amount) {
  const inv = inventory(player); const stack = new ItemStack(typeId, amount);
  const rest = inv.addItem(stack); if (rest) player.dimension.spawnItem(rest, player.location);
}
function safe(player, fn) { try { fn(); } catch (e) { player.sendMessage(`§cОшибка: ${e}`); } }

function showMarket(player) {
  const form = new ActionFormData().title("Глобальный рынок").body(`Баланс: §6${money(player)} монет`);
  for (const g of GOODS) form.button(`${g.name}  ${trend(g.id)}  §6${marketPrice(g.id)} монет\nВ наличии: ${state.listings.filter(x => x.item === g.id).length}`);
  form.button("Назад");
  form.show(player).then(r => {
    if (r.canceled || r.selection === GOODS.length) return;
    const good = GOODS[r.selection];
    new ActionFormData().title(good.name).body(`Цена: ${marketPrice(good.id)} монет\nПродажа NPC: ${good.buy} монет`).button("Купить у рынка").button("Продать NPC").button("Назад").show(player).then(a => {
      if (a.canceled || a.selection === 2) return showMarket(player);
      if (a.selection === 0) buyListed(player, good);
      else sellToTrader(player, good);
    });
  });
}
function buyListed(player, good) {
  const listing = state.listings.find(x => x.item === good.id);
  if (!listing) return player.sendMessage("§eЭтого товара сейчас нет на рынке.");
  const price = listing.price;
  if (money(player) < price) return player.sendMessage("§cНедостаточно монет.");
  playerData(player).balance -= price;
  if (listing.owner !== "NPC" && state.players[listing.owner]) state.players[listing.owner].balance += price;
  state.listings.splice(state.listings.indexOf(listing), 1); give(player, good.id, 1); save();
  player.sendMessage(`§aКуплено: ${good.name} за ${price} монет.`);
}
function sellToTrader(player, good) {
  if (!countItem(player, good.id)) return player.sendMessage("§cУ вас нет этого предмета.");
  if (!removeItem(player, good.id, 1)) return;
  const payout = good.buy;
  playerData(player).balance += payout;
  state.listings.push({ item: good.id, price: Math.max(payout + 1, marketPrice(good.id) + 5), owner: "NPC", created: Date.now() });
  save(); player.sendMessage(`§aПродано NPC за ${payout} монет. Товар выставлен на рынок.`);
}
function showStalls(player) {
  const mine = state.listings.filter(x => x.owner === player.id);
  new ActionFormData().title("Мои товары / лавки").body(`Активных товаров: ${mine.length}`).button("Выставить предмет из руки").button("Снять первое объявление").button("Назад").show(player).then(r => {
    if (r.canceled || r.selection === 2) return;
    if (r.selection === 0) {
      const held = player.getComponent("minecraft:inventory").container.getItem(player.selectedSlotIndex);
      if (!held || held.typeId === BOOK) return player.sendMessage("§cВозьмите продаваемый предмет в руку.");
      new ModalFormData().title("Новая лавка").slider("Количество", 1, held.amount, 1, 1).textField("Цена за штуку", "Например: 12").show(player).then(x => {
        if (x.canceled) return;
        const qty = Number(x.formValues[0]), price = Math.floor(Number(x.formValues[1]));
        if (!Number.isFinite(price) || price < 1 || qty < 1 || countItem(player, held.typeId) < qty || !removeItem(player, held.typeId, qty)) return player.sendMessage("§cКоличество или цена некорректны.");
        for (let i = 0; i < qty; i++) state.listings.push({ item: held.typeId, price, owner: player.id, created: Date.now() });
        save(); player.sendMessage("§aТовар выставлен на глобальном рынке.");
      });
    } else {
      const item = mine[0]; if (!item) return player.sendMessage("§eУ вас нет активных товаров.");
      state.listings.splice(state.listings.indexOf(item), 1); give(player, item.item, 1); save(); player.sendMessage("§aОбъявление снято.");
    }
  });
}
function transfer(player) {
  new ModalFormData().title("Перевод денег").textField("Имя игрока", "Игрок онлайн").textField("Сумма", "100").show(player).then(r => {
    if (r.canceled) return;
    const target = world.getPlayers().find(p => p.name.toLowerCase() === String(r.formValues[0]).toLowerCase());
    const amount = Math.floor(Number(r.formValues[1]));
    if (!target || target.id === player.id || !Number.isFinite(amount) || amount < 1 || money(player) < amount) return player.sendMessage("§cИгрок или сумма указаны неверно.");
    playerData(player).balance -= amount; playerData(target).balance += amount; save();
    player.sendMessage(`§aПереведено ${amount} монет игроку ${target.name}.`); target.sendMessage(`§a${player.name} перевёл вам ${amount} монет.`);
  });
}
function bookMenu(player) {
  playerData(player);
  new ActionFormData().title("Книга экономики").body(`Баланс: §6${money(player)} монет`).button("Рынок").button("Мои товары / лавки").button("Перевод денег").show(player).then(r => {
    if (r.canceled) return;
    if (r.selection === 0) showMarket(player);
    if (r.selection === 1) showStalls(player);
    if (r.selection === 2) transfer(player);
  });
}
function isPortal(block) { return block?.typeId === "minecraft:chest" && state.portals.some(p => p.x === block.location.x && p.y === block.location.y && p.z === block.location.z && p.dimension === block.dimension.id); }

world.afterEvents.worldLoad.subscribe(() => load());
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  playerData(player);
  if (!initialSpawn) return;
  system.runTimeout(() => {
    const inv = inventory(player);
    let found = false; for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === BOOK) found = true;
    if (!found) give(player, BOOK, 1);
    player.sendMessage("§aКнига экономики выдана. Используйте её, чтобы открыть рынок.");
  }, 20);
});
world.afterEvents.itemUse.subscribe(({ source, itemStack }) => { if (itemStack.typeId === BOOK) bookMenu(source); });
world.afterEvents.playerInteractWithBlock.subscribe(({ player, block }) => { if (isPortal(block)) showMarket(player); });

system.runInterval(() => {
  for (const g of GOODS) state.history[g.id] = marketPrice(g.id);
  save();
}, 1200);

const commands = ["setmarketportal", "removemarketportal", "marketbalance"];
world.beforeEvents.chatSend.subscribe(event => {
  const match = event.message.match(/^\/(setmarketportal|removemarketportal|marketbalance)(?:\s+(.*))?$/i);
  if (!match) return;
  event.cancel = true;
  const player = event.sender;
  safe(player, () => {
    if (!player.isOp()) return player.sendMessage("§cКоманда доступна только OP.");
    const command = match[1].toLowerCase();
    if (command === "marketbalance") return player.sendMessage(`§aБаланс: ${money(player)} монет.`);
    const block = player.getBlockFromViewDirection({ maxDistance: 6 })?.block;
    if (!block || block.typeId !== "minecraft:chest") return player.sendMessage("§cПосмотрите на сундук с расстояния до 6 блоков.");
    const point = { x: block.location.x, y: block.location.y, z: block.location.z, dimension: block.dimension.id };
    const idx = state.portals.findIndex(p => p.x === point.x && p.y === point.y && p.z === point.z && p.dimension === point.dimension);
    if (command === "setmarketportal") {
      if (idx < 0) state.portals.push(point);
      player.sendMessage("§aПортал рынка привязан к сундуку. Добавьте над сундуком табличку «↓ Рынок» для визуального обозначения.");
    } else {
      if (idx >= 0) state.portals.splice(idx, 1);
      player.sendMessage("§aПортал снят.");
    }
    save();
  });
});
