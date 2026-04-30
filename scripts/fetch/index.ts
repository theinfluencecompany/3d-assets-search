const args = process.argv.slice(2);

async function run(label: string, script: string) {
  console.log(`\n${"=".repeat(18)} ${label} ${"=".repeat(18)}`);
  const proc = Bun.spawn(["bun", script, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${label} failed with exit code ${code}`);
  }
}

async function main() {
  await run("poly.pizza", "scripts/fetch/polypizza.ts");
  await run("polyhaven", "scripts/fetch/polyhaven.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
