import { BOOKMAKER_COLLECTORS } from "../bookmakers/registry.js";

const slug = process.argv[2];

if (!slug) {
  console.error("Informe a casa: npm run collect:bookmaker -- esportiva");
  process.exitCode = 1;
} else {
  const bookmaker = BOOKMAKER_COLLECTORS.find((item) => item.slug === slug);

  if (!bookmaker) {
    console.error(`Casa nao configurada ou desativada: ${slug}`);
    process.exitCode = 1;
  } else {
    try {
      const summary = await bookmaker.collect();
      console.log(JSON.stringify({ bookmaker: bookmaker.slug, summary }, null, 2));
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
}
