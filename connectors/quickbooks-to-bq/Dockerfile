# Python 3.10 (not 3.11): hotgluexyz/tap-quickbooks pulls
# `hotglue-singer-sdk<2.0.0,>=1.0.15`, and every 1.x version of that SDK
# requires Python <3.11. The 3.x versions of the SDK exist but the tap
# pins to 1.x, so we can't bump there either. Net: python3.10 is the
# only Python that satisfies both the tap version pin and the SDK's
# Python constraint. See LIVELI-132 PR-merge deploy failure.
FROM meltano/meltano:v3.7.1-python3.10
WORKDIR /project
COPY meltano.yml ./
RUN meltano lock --update --all && meltano install
RUN .meltano/loaders/target-bigquery/venv/bin/pip install 'setuptools<81'
RUN pip install --no-cache-dir gcsfs google-cloud-storage
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
ENTRYPOINT ["./entrypoint.sh"]
