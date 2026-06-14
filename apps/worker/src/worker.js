const exampleJob = {
  assetVersionId: "ver_demo_1",
  inputPath: "/mnt/nas/projects/demo/clip-a-cam.mov",
  outputPrefix: "s3://frame-proxy/proj_demo/asset_demo_1/ver_1/"
};

function buildTranscodePlan(job) {
  return {
    ...job,
    profiles: [
      { name: "low", width: 960, height: 540, bitrateKbps: 1800 },
      { name: "medium", width: 1280, height: 720, bitrateKbps: 3500 },
      { name: "high", width: 1920, height: 1080, bitrateKbps: 8000 }
    ],
    segmentSeconds: 4
  };
}

console.log("Transcode worker skeleton ready");
console.log(JSON.stringify(buildTranscodePlan(exampleJob), null, 2));
