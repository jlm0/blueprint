const held = [];
for (;;) {
  held.push(Array.from({ length: 1_000_000 }, () => held.length));
}
