const stage = $app.stage;
const isProd = stage === "production";
const isDev = stage === "dev";

export const vpc = !isProd
	? await aws.ec2
			.getVpc({ tags: { "sst:app": $app.name, "sst:stage": "production" } })
			.then((existing) => sst.aws.Vpc.get("ProcellaVpc", existing.id))
	: new sst.aws.Vpc("ProcellaVpc", {
			nat: "ec2",
			transform: {
				// SST's NAT instance security group allows all inbound traffic from 0.0.0.0/0.
				// The NAT only forwards egress from the VPC's private subnets, so accept inbound
				// from the VPC CIDR only. Egress stays open; that is the NAT's job.
				natSecurityGroup: (args) => {
					args.ingress = [
						{
							protocol: "-1",
							fromPort: 0,
							toPort: 0,
							cidrBlocks: [aws.ec2.getVpcOutput({ id: args.vpcId }).cidrBlock],
						},
					];
				},
			},
		});

export const database = isProd
	? new sst.aws.Aurora("ProcellaDatabase", {
			engine: "postgres",
			dataApi: true,
			scaling: { min: "0 ACU", max: "16 ACU", pauseAfter: "5 minutes" },
			vpc,
			transform: {
				cluster: {
					storageType: "aurora-iopt1",
				},
			},
		})
	: isDev
		? new sst.aws.Aurora("ProcellaDevDatabase", {
				engine: "postgres",
				dataApi: true,
				scaling: { min: "0 ACU", max: "4 ACU", pauseAfter: "5 minutes" },
				vpc,
				dev: {
					username: "procella",
					password: "procella",
					database: "procella",
					host: "localhost",
					port: 5432,
				},
			})
		: await aws.rds
				.getClusters({})
				.then(
					(clusters) =>
						clusters.clusterIdentifiers.find((id) => id.startsWith("procella-dev-")) ||
						(() => {
							throw new Error("Dev database not found \u2014 deploy the 'dev' stage first");
						})(),
				)
				.then((existing) => sst.aws.Aurora.get("ProcellaDevDatabase", existing));

export const databaseName = $dev
	? "procella"
	: stage === "production"
		? "procella"
		: `procella_${stage.replace(/-/g, "_")}`;

export const databaseUrl = $dev
	? $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}/${databaseName}`
	: $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}/${databaseName}?sslmode=require`;
