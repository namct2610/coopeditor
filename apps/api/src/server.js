import { createServer } from "node:http";

const sampleProject = {
  id: "proj_demo",
  name: "Demo Project",
  createdAt: new Date().toISOString()
};

const sampleAssetVersion = {
  id: "ver_demo_1",
  assetId: "asset_demo_1",
  versionNumber: 1,
  sourcePath: "/mnt/nas/projects/demo/clip-a-cam.mov",
  proxyStatus: "processing",
  createdAt: new Date().toISOString()
};

const routes = {
  "/health": () => ({ ok: true }),
  "/projects": () => [sampleProject],
  "/asset-versions": () => [sampleAssetVersion]
};

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  const handler = routes[url];

  res.setHeader("content-type", "application/json; charset=utf-8");

  if (!handler) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  res.end(JSON.stringify(handler()));
});

const port = Number(process.env.PORT ?? 4000);

server.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
