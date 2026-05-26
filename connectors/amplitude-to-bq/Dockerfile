# Python 3.10 (not 3.11): singer-io/tap-amplitude has setup.py
# constraints capped at Python <3.11 via its own ancient dependencies.
# Same class of issue as tap-quickbooks. See LIVELI-128 PR-merge deploy
# failure.
FROM meltano/meltano:v3.7.1-python3.10
WORKDIR /project
COPY meltano.yml ./
RUN meltano lock --update --all && meltano install
RUN .meltano/loaders/target-bigquery/venv/bin/pip install 'setuptools<81'
RUN pip install --no-cache-dir gcsfs google-cloud-storage
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
ENTRYPOINT ["./entrypoint.sh"]
